import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { validateAgainstSchema, type SchemaNode, type SchemaRoot } from "./schema-validator.js";

export type PnlPositionsPeriod = "daily" | "weekly";

/** OpenAPI 0.294.0 profile enrichment, present per board or absent per board. */
export interface PnlPositionProfile {
  username: string | null;
  profileImage: string | null;
  xUsername: string | null;
  isVerified: boolean;
  verifiedBadgeVisible: boolean;
  userId: string | null;
}
/** Local inputs, not a recovered database schema or a PnL fold. */
export interface PnlPositionFact {
  walletAddress: string;
  coinMint: string;
  pnlUsd: number | null;
  pnlPercentage: number | null;
  amountHeld: number | null;
  isExited: boolean | null;
  costBasisAmount: number | null;
  costBasisUsd: number | null;
  amountBoughtUsd: number | null;
  amountBought: number | null;
  realizedPnlUsd: number | null;
  avgEntryMcapUsd: number | null;
  /** OpenAPI 0.294.0 callout object; never null, as declared. */
  callout: Record<string, unknown>;
  leaderboardPnlUsd: number;
  heldValueSol: number;
  valueUsd: number | null;
  lastRefreshedAtMs: number;
  profile: PnlPositionProfile | null;
}
export interface PnlPositionsDataset {
  schemaVersion: 1;
  dataSource: "synthetic" | "local-materialized";
  observedAt: string;
  boards: Partial<
    Record<PnlPositionsPeriod, { periodLabel: string; windowStartSec: number; rows: PnlPositionFact[] }>
  >;
}
export type PnlPositionEntry = { rank: number } & Omit<PnlPositionFact, "profile"> &
  Partial<PnlPositionProfile> & { followedHolders?: null };
export interface PnlPositionsBoard {
  entries: PnlPositionEntry[];
  periodLabel: string;
  windowStartSec: number;
  totalRanked: number;
}
export class UnavailablePnlPositionsError extends Error {}

const periods: readonly string[] = ["daily", "weekly"];
const NULLABLE_MEASURES = [
  "pnlUsd", "pnlPercentage", "amountHeld", "costBasisAmount", "costBasisUsd",
  "amountBoughtUsd", "amountBought", "realizedPnlUsd", "avgEntryMcapUsd",
] as const;
const ROW_KEYS = [
  "walletAddress", "coinMint", ...NULLABLE_MEASURES, "isExited", "callout",
  "leaderboardPnlUsd", "heldValueSol", "valueUsd", "lastRefreshedAtMs", "profile",
];
const PROFILE_KEYS = [
  "username", "profileImage", "xUsername", "isVerified", "verifiedBadgeVisible", "userId",
] as const;
/** Declared: rows served, default and ceiling 25. */
const MAX_LIMIT = 25;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = 10_000;

const spec = JSON.parse(
  new TextDecoder("utf-8", { fatal: true }).decode(
    readFileSync(new URL("../../../contracts/developer.openapi.json", import.meta.url)),
  ),
) as SchemaRoot & { paths: Record<string, any> };
const calloutSchema: SchemaNode =
  spec.paths["/pnl-leaderboard/positions"].get.responses["200"].content["application/json"]
    .schema.properties.entries.items.properties.callout;

function invalid(field: string): never {
  throw new TypeError(`Invalid local PnL positions dataset: ${field}`);
}
function record(value: unknown, keys: readonly string[], field: string) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid(field);
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(item, key))
  )
    invalid(field);
  return item;
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
function nullableText(value: unknown, field: string): string | null {
  return value === null ? null : text(value, field);
}
function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(field);
  return value;
}
function nullableFinite(value: unknown, field: string): number | null {
  return value === null ? null : finite(value, field);
}
function count(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(field);
  return value as number;
}
function flag(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(field);
  return value;
}
function list(value: unknown, max: number, field: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(field);
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) invalid(field);
  }
  return value;
}
/** Declared: hasLiked and hasReposted are null until a viewer is known; the API host has none. */
function viewerless(callout: Record<string, unknown>): boolean {
  return ["hasLiked", "hasReposted"].every((key) => !Object.hasOwn(callout, key) || callout[key] === null);
}
export function isPnlPositionsPeriod(value: string | undefined): value is PnlPositionsPeriod {
  return value !== undefined && periods.includes(value);
}

interface StoredBoard {
  periodLabel: string;
  windowStartSec: number;
  rows: PnlPositionFact[];
}

/** Immutable, opt-in read model. No seeded boards, live data, viewer overlay or writes. */
export class PnlPositionsStore {
  readonly dataSource: PnlPositionsDataset["dataSource"];
  readonly observedAt: string;
  readonly #boards = new Map<string, StoredBoard>();

  constructor(input: unknown) {
    const data = record(input, ["schemaVersion", "dataSource", "observedAt", "boards"], "root");
    if (
      data.schemaVersion !== 1 ||
      (data.dataSource !== "synthetic" && data.dataSource !== "local-materialized")
    )
      invalid("version/source");
    this.dataSource = data.dataSource;
    const observedAt = text(data.observedAt, "observedAt");
    const observedAtMs = Date.parse(observedAt);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(observedAt) ||
      !Number.isFinite(observedAtMs) ||
      new Date(observedAtMs).toISOString() !== observedAt
    )
      invalid("observedAt");
    this.observedAt = observedAt;

    if (!data.boards || typeof data.boards !== "object" || Array.isArray(data.boards))
      invalid("boards");
    const boardKeys = Object.keys(data.boards);
    if (boardKeys.some((key) => !periods.includes(key))) invalid("boards");
    const boards = record(data.boards, boardKeys, "boards");
    for (const period of boardKeys) {
      const board = record(boards[period], ["periodLabel", "windowStartSec", "rows"], "board");
      const windowStartSec = count(board.windowStartSec, "board.windowStartSec");
      if (windowStartSec * 1000 > observedAtMs) invalid("board.windowStartSec");
      const positions = new Set<string>();
      const rows = list(board.rows, MAX_ROWS, "board.rows").map((value) => {
        const row = record(value, ROW_KEYS, "row");
        const walletAddress = text(row.walletAddress, "row.walletAddress");
        const coinMint = text(row.coinMint, "row.coinMint");
        const key = JSON.stringify([walletAddress, coinMint]);
        if (positions.has(key)) invalid("duplicate position");
        positions.add(key);
        // Snapshot and check the declared closed callout shape before serving it.
        const callout = structuredClone(row.callout) as Record<string, unknown>;
        if (
          !callout ||
          typeof callout !== "object" ||
          Array.isArray(callout) ||
          validateAgainstSchema(callout, calloutSchema, "$", spec).length ||
          !viewerless(callout)
        )
          invalid("row.callout");
        const quoted = callout.quotedCallout as { callout: Record<string, unknown> } | null;
        // Declared: one level deep, its own quotedCallout always null.
        if (quoted !== null && (!viewerless(quoted.callout) || quoted.callout.quotedCallout !== null))
          invalid("row.callout.quotedCallout");
        const lastRefreshedAtMs = count(row.lastRefreshedAtMs, "row.lastRefreshedAtMs");
        if (lastRefreshedAtMs > observedAtMs) invalid("row.lastRefreshedAtMs");
        let profile: PnlPositionProfile | null = null;
        if (row.profile !== null) {
          const supplied = record(row.profile, PROFILE_KEYS, "row.profile");
          profile = {
            username: nullableText(supplied.username, "profile.username"),
            profileImage: nullableText(supplied.profileImage, "profile.profileImage"),
            xUsername: nullableText(supplied.xUsername, "profile.xUsername"),
            isVerified: flag(supplied.isVerified, "profile.isVerified"),
            verifiedBadgeVisible: flag(supplied.verifiedBadgeVisible, "profile.verifiedBadgeVisible"),
            userId: nullableText(supplied.userId, "profile.userId"),
          };
        }
        const fact = {
          walletAddress,
          coinMint,
          isExited: row.isExited === null ? null : flag(row.isExited, "row.isExited"),
          callout,
          leaderboardPnlUsd: finite(row.leaderboardPnlUsd, "row.leaderboardPnlUsd"),
          heldValueSol: finite(row.heldValueSol, "row.heldValueSol"),
          valueUsd: nullableFinite(row.valueUsd, "row.valueUsd"),
          lastRefreshedAtMs,
          profile,
        } as PnlPositionFact;
        for (const measure of NULLABLE_MEASURES)
          fact[measure] = nullableFinite(row[measure], `row.${measure}`);
        return fact;
      });
      // Declared: profile fields are present only when the board had a wallet to enrich.
      if (new Set(rows.map((row) => row.profile === null)).size > 1) invalid("board.profiles");
      this.#boards.set(period, {
        periodLabel: text(board.periodLabel, "board.periodLabel"),
        windowStartSec,
        rows,
      });
    }
  }

  board(query: {
    period: PnlPositionsPeriod;
    includeFollowedHolders?: boolean;
    followedHoldersLimit?: number;
    limit?: number;
  }): PnlPositionsBoard {
    const { period } = query;
    if (
      !isPnlPositionsPeriod(period) ||
      (query.includeFollowedHolders !== undefined && typeof query.includeFollowedHolders !== "boolean") ||
      (query.followedHoldersLimit !== undefined &&
        (!Number.isSafeInteger(query.followedHoldersLimit) || query.followedHoldersLimit < 1)) ||
      (query.limit !== undefined && !Number.isSafeInteger(query.limit))
    )
      throw new RangeError("Invalid PnL positions query");
    const board = this.#boards.get(period);
    if (!board) throw new UnavailablePnlPositionsError("No supplied PnL positions board");
    // The lower clamp at 0 is local; the supplied row order is the producer's ranking.
    const limit = Math.min(MAX_LIMIT, Math.max(0, query.limit ?? MAX_LIMIT));
    // The facepile is viewer-relative and the API host has no viewer, so an
    // opted-in entry carries followedHolders: null whatever followedHoldersLimit says.
    return {
      entries: board.rows.slice(0, limit).map(({ profile, callout, ...row }, index) => ({
        rank: index + 1,
        ...row,
        callout: structuredClone(callout),
        ...(profile ?? {}),
        ...(query.includeFollowedHolders ? { followedHolders: null } : {}),
      })),
      periodLabel: board.periodLabel,
      windowStartSec: board.windowStartSec,
      totalRanked: board.rows.length,
    };
  }
}

/** Startup-only, bounded regular-file read. No writes, reloads or network. */
export function loadPnlPositionsStore(
  path: string | undefined,
  noFollow: number | undefined = constants.O_NOFOLLOW,
): PnlPositionsStore | undefined {
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
    return new PnlPositionsStore(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))),
    );
  } finally {
    closeSync(fd);
  }
}
