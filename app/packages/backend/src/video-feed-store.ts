import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { validateAgainstSchema, type SchemaNode, type SchemaRoot } from "./schema-validator.js";

/** One OpenAPI 0.294.0 feed item: a clip with its coin, or a live coin. Shapes come from the pinned spec. */
export type VideoFeedItem =
  | { feedItemType: "clip"; clip: Record<string, unknown>; coin: Record<string, unknown> }
  | { feedItemType: "live"; coin: Record<string, unknown> };
export interface VideoFeedDataset {
  schemaVersion: 1;
  dataSource: "synthetic" | "local-materialized";
  observedAt: string;
  /** The curated feed in the producer's order. */
  items: VideoFeedItem[];
}

const spec = JSON.parse(
  new TextDecoder("utf-8", { fatal: true }).decode(
    readFileSync(new URL("../../../contracts/developer.openapi.json", import.meta.url)),
  ),
) as SchemaRoot & { paths: Record<string, any> };
const itemSchema: SchemaNode =
  spec.paths["/feed/video-feed"].get.responses["200"].content["application/json"].schema.items;

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ITEMS = 1_000;
const ISO_8601 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function invalid(field: string): never {
  throw new TypeError(`Invalid local video feed dataset: ${field}`);
}
function plain(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}
/** An ISO 8601 date-time with a zone, every component in range (no silent rollover); returns epoch ms. */
function isoInstant(value: unknown, field: string): number {
  const match = typeof value === "string" ? ISO_8601.exec(value) : null;
  if (!match) invalid(field);
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59)
    invalid(field);
  const offsetHours = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinutes = match[11] === undefined ? 0 : Number(match[11]);
  if (offsetHours > 23 || offsetMinutes > 59) invalid(field);
  const offset = (match[9] === "-" ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * 60_000;
  const fraction = match[7] === undefined ? 0 : Number(`0.${match[7]}`) * 1000;
  return Date.UTC(year, month - 1, day, hour, minute, second) + fraction - offset;
}
function nonNegativeInteger(value: unknown, field: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) invalid(field);
}

/** Declared coin invariants the structural schema cannot express. */
function checkCoin(coin: Record<string, unknown>): void {
  for (const key of ["name", "symbol"])
    if (typeof coin[key] === "string" && !(coin[key] as string).trim()) invalid(`coin.${key}`);
  for (const key of ["description", "image_uri", "metadata_uri"]) if (coin[key] === "") invalid(`coin.${key}`);
  if (Object.hasOwn(coin, "image_backdrop") && !Object.hasOwn(coin, "image_uri")) invalid("coin.image_backdrop");
  if (coin.usd_market_cap === 0) invalid("coin.usd_market_cap");
  for (const key of ["thumbnail", "thumbnail_updated_at", "num_participants"])
    if (Object.hasOwn(coin, key) && coin.is_currently_live !== true) invalid(`coin.${key}`);
  for (const key of ["issuer", "underlying_symbol"])
    if (coin[key] !== undefined && coin[key] !== null && (coin.asset_class === undefined || coin.asset_class === null))
      invalid(`coin.${key}`);
}

/** Immutable, opt-in read model. No curation, ranking, livestream lookup, coin enrichment or writes. */
export class VideoFeedStore {
  readonly dataSource: VideoFeedDataset["dataSource"];
  readonly observedAt: string;
  readonly #items: string;

  constructor(input: unknown) {
    if (!plain(input)) invalid("root");
    const keys = ["schemaVersion", "dataSource", "observedAt", "items"];
    if (Object.keys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key))) invalid("root");
    if (
      input.schemaVersion !== 1 ||
      (input.dataSource !== "synthetic" && input.dataSource !== "local-materialized")
    )
      invalid("version/source");
    this.dataSource = input.dataSource;
    const observedAt = input.observedAt;
    if (
      typeof observedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(observedAt) ||
      !Number.isFinite(Date.parse(observedAt)) ||
      new Date(Date.parse(observedAt)).toISOString() !== observedAt
    )
      invalid("observedAt");
    this.observedAt = observedAt;
    const observedAtMs = Date.parse(observedAt);

    const items = input.items;
    if (!Array.isArray(items) || items.length > MAX_ITEMS) invalid("items");
    const clipIds = new Set<string>();
    const liveMints = new Set<string>();
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (!plain(item) || validateAgainstSchema(item, itemSchema, "$", spec).length) invalid("item");
      const coin = item.coin as Record<string, unknown>;
      checkCoin(coin);
      if (item.feedItemType === "live") {
        if (liveMints.has(coin.mint as string)) invalid("duplicate live coin");
        liveMints.add(coin.mint as string);
        continue;
      }
      const clip = item.clip as Record<string, unknown>;
      if (clipIds.has(clip.clipId as string)) invalid("duplicate clip");
      clipIds.add(clip.clipId as string);
      // Declared: the clip was recorded in this coin's room, and hidden clips never reach the feed.
      if (clip.roomName !== coin.mint) invalid("clip.roomName");
      if (clip.hidden === true) invalid("clip.hidden");
      const start = isoInstant(clip.startTime, "clip.startTime");
      const end = isoInstant(clip.endTime, "clip.endTime");
      if (end < start || end > observedAtMs) invalid("clip.endTime");
      if ((clip.duration as number) < 0) invalid("clip.duration");
      nonNegativeInteger(clip.viewCount, "clip.viewCount");
      nonNegativeInteger(clip.mp4SizeBytes, "clip.mp4SizeBytes");
    }
    // Rows are forwarded verbatim; the serialized snapshot is the store's own copy.
    this.#items = JSON.stringify(items);
  }

  feed(): VideoFeedItem[] {
    return JSON.parse(this.#items) as VideoFeedItem[];
  }
}

/** Startup-only, bounded regular-file read. No writes, reloads or network. */
export function loadVideoFeedStore(
  path: string | undefined,
  noFollow: number | undefined = constants.O_NOFOLLOW,
): VideoFeedStore | undefined {
  if (!path) return undefined;
  // O_NOFOLLOW is undefined on Windows, so the open flag alone cannot reject a
  // symlinked path there: inspect the path itself and bind the descriptor to it.
  const linked = lstatSync(path, { bigint: true });
  if (linked.isSymbolicLink() || !linked.isFile()) invalid("file type/size");
  const fd = openSync(path, constants.O_RDONLY | (noFollow ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(MAX_FILE_BYTES)) invalid("file type/size");
    if (stat.dev !== linked.dev || stat.ino !== linked.ino) invalid("file identity");
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = readSync(fd, buffer, size, buffer.length - size, null);
      if (read === 0) break;
      size += read;
    }
    if (size > MAX_FILE_BYTES) invalid("file size");
    return new VideoFeedStore(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))),
    );
  } finally {
    closeSync(fd);
  }
}
