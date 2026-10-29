import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";

export interface AchievementOverlaysDataset {
  schemaVersion: 1;
  dataSource: "synthetic" | "local-materialized";
  observedAt: string;
  /** Per wallet address or user id, its top badge ids in the producer's order. */
  overlays: Record<string, string[]>;
}
export class UnavailableAchievementOverlaysError extends Error {}

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_IDS = 100_000;
const MAX_BADGES = 100;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Solana base58 wallet, an EVM 0x wallet, or a UUID user id: the formats the contract disambiguates. */
export function isOverlayId(value: unknown): value is string {
  return typeof value === "string" && (SOLANA_ADDRESS.test(value) || EVM_ADDRESS.test(value) || USER_ID.test(value));
}

function invalid(field: string): never {
  throw new TypeError(`Invalid local achievement overlays dataset: ${field}`);
}
function plain(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}
function record(value: unknown, keys: readonly string[], field: string) {
  if (!plain(value)) invalid(field);
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    invalid(field);
  return value;
}
function text(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 64 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    invalid(field);
  return value;
}

/** Immutable, opt-in read model. No badge ranking, unlock lookup, wallet/user-id resolution or writes. */
export class AchievementOverlaysStore {
  readonly dataSource: AchievementOverlaysDataset["dataSource"];
  readonly observedAt: string;
  readonly #overlays = new Map<string, readonly string[]>();

  constructor(input: unknown) {
    const data = record(input, ["schemaVersion", "dataSource", "observedAt", "overlays"], "root");
    if (
      data.schemaVersion !== 1 ||
      (data.dataSource !== "synthetic" && data.dataSource !== "local-materialized")
    )
      invalid("version/source");
    this.dataSource = data.dataSource;
    const observedAt = data.observedAt;
    if (
      typeof observedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(observedAt) ||
      !Number.isFinite(Date.parse(observedAt)) ||
      new Date(Date.parse(observedAt)).toISOString() !== observedAt
    )
      invalid("observedAt");
    this.observedAt = observedAt;

    if (!plain(data.overlays)) invalid("overlays");
    const ids = Object.keys(data.overlays);
    if (ids.length > MAX_IDS) invalid("overlays");
    for (const id of ids) {
      if (!isOverlayId(id)) invalid("overlay id");
      const badges = data.overlays[id];
      if (!Array.isArray(badges) || badges.length > MAX_BADGES) invalid("overlay badges");
      const seen = new Set<string>();
      for (let index = 0; index < badges.length; index++) {
        const badge = text(badges[index], "overlay badge");
        if (seen.has(badge)) invalid("duplicate overlay badge");
        seen.add(badge);
      }
      this.#overlays.set(id, Object.freeze([...seen]));
    }
  }

  /** All-or-nothing: every requested id must have supplied badges, or none is served. */
  overlays(ids: readonly string[]): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const id of ids) {
      const badges = this.#overlays.get(id);
      if (!badges) throw new UnavailableAchievementOverlaysError("No supplied overlay for a requested id");
      result[id] = [...badges];
    }
    return result;
  }
}

/** Startup-only, bounded regular-file read. No writes, reloads or network. */
export function loadAchievementOverlaysStore(
  path: string | undefined,
  noFollow: number | undefined = constants.O_NOFOLLOW,
): AchievementOverlaysStore | undefined {
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
    return new AchievementOverlaysStore(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))),
    );
  } finally {
    closeSync(fd);
  }
}
