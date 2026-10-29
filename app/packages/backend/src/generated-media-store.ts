import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";

export interface GeneratedMediaEntry {
  isVerified: boolean;
  verifiedBadgeVisible: boolean;
  pnlLoop?: { uid: string; durationSeconds: number };
  replayIntro?: { uid: string; durationSeconds: number; fireAt: number };
}
export interface GeneratedMediaDataset {
  schemaVersion: 1;
  dataSource: "synthetic" | "local-materialized";
  observedAt: string;
  /** Per wallet address or user id, its badge facts and any rendered share media. `unseen` is never supplied. */
  entries: Record<string, GeneratedMediaEntry>;
}
export class UnavailableGeneratedMediaError extends Error {}

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_IDS = 100_000;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Solana base58 wallet, an EVM 0x wallet, or a UUID user id: the formats the contract disambiguates. */
export function isProfileId(value: unknown): value is string {
  return typeof value === "string" && (SOLANA_ADDRESS.test(value) || EVM_ADDRESS.test(value) || USER_ID.test(value));
}

function invalid(field: string): never {
  throw new TypeError(`Invalid local generated media dataset: ${field}`);
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
    value.length > 2048 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    invalid(field);
  return value;
}
function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(field);
  return value;
}
function seconds(value: unknown, field: string, allowZero: boolean): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0))
    invalid(field);
  return value;
}

/** Immutable, opt-in read model. No verification lookup, media rendering, owner state or writes. */
export class GeneratedMediaStore {
  readonly dataSource: GeneratedMediaDataset["dataSource"];
  readonly observedAt: string;
  readonly #entries = new Map<string, GeneratedMediaEntry>();

  constructor(input: unknown) {
    const data = record(input, ["schemaVersion", "dataSource", "observedAt", "entries"], "root");
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

    if (!plain(data.entries)) invalid("entries");
    const ids = Object.keys(data.entries);
    if (ids.length > MAX_IDS) invalid("entries");
    for (const id of ids) {
      if (!isProfileId(id)) invalid("entry id");
      const row = data.entries[id];
      if (!plain(row)) invalid("entry");
      if (Object.keys(row).some((key) => !["isVerified", "verifiedBadgeVisible", "pnlLoop", "replayIntro"].includes(key)))
        invalid("entry");
      const entry: GeneratedMediaEntry = {
        isVerified: bool(row.isVerified, "entry.isVerified"),
        verifiedBadgeVisible: bool(row.verifiedBadgeVisible, "entry.verifiedBadgeVisible"),
      };
      if (Object.hasOwn(row, "pnlLoop")) {
        const loop = record(row.pnlLoop, ["uid", "durationSeconds"], "entry.pnlLoop");
        entry.pnlLoop = {
          uid: text(loop.uid, "pnlLoop.uid"),
          durationSeconds: seconds(loop.durationSeconds, "pnlLoop.durationSeconds", false),
        };
      }
      if (Object.hasOwn(row, "replayIntro")) {
        // The shared media shape requires the PnL loop and makes only the intro optional.
        if (!entry.pnlLoop) invalid("entry.replayIntro without pnlLoop");
        const intro = record(row.replayIntro, ["uid", "durationSeconds", "fireAt"], "entry.replayIntro");
        entry.replayIntro = {
          uid: text(intro.uid, "replayIntro.uid"),
          durationSeconds: seconds(intro.durationSeconds, "replayIntro.durationSeconds", false),
          fireAt: seconds(intro.fireAt, "replayIntro.fireAt", true),
        };
      }
      this.#entries.set(id, entry);
    }
  }

  /** All-or-nothing: every requested id must have a supplied entry, or none is served. */
  entries(ids: readonly string[]): Record<string, GeneratedMediaEntry> {
    const result: Record<string, GeneratedMediaEntry> = {};
    for (const id of ids) {
      const entry = this.#entries.get(id);
      if (!entry) throw new UnavailableGeneratedMediaError("No supplied entry for a requested id");
      result[id] = {
        isVerified: entry.isVerified,
        verifiedBadgeVisible: entry.verifiedBadgeVisible,
        ...(entry.pnlLoop && { pnlLoop: { ...entry.pnlLoop } }),
        ...(entry.replayIntro && { replayIntro: { ...entry.replayIntro } }),
      };
    }
    return result;
  }
}

/** Startup-only, bounded regular-file read. No writes, reloads or network. */
export function loadGeneratedMediaStore(
  path: string | undefined,
  noFollow: number | undefined = constants.O_NOFOLLOW,
): GeneratedMediaStore | undefined {
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
    return new GeneratedMediaStore(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))),
    );
  } finally {
    closeSync(fd);
  }
}
