import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";

export type GroupBoardPeriod = "daily" | "weekly" | "monthly";
export type GroupBoardSort = "realized" | "unrealized" | "combined";

/** Local inputs, not a recovered database schema or a PnL fold. */
export interface GroupBoardPosition {
  mint: string;
  chainId: number;
  symbol: string | null;
  name: string | null;
  imageUri: string | null;
  /** Fresh USD value used only to order icons; never served. */
  valueUsd: number;
}
export interface GroupBoardFact {
  groupId: string;
  memberCount: number;
  membersCounted: number;
  username: string | null;
  profileImageUrl: string | null;
  isVerified: boolean;
  verifiedBadgeVisible: boolean;
  pnlSol: number;
  pnlUsd: number;
  pnlPercent: number;
  buySpendSol: number;
  lastRefreshedAtMs: number;
  realizedPnlSol: number;
  realizedPnlUsd: number;
  unrealizedPnlSol: number;
  unrealizedPnlUsd: number;
  positions: GroupBoardPosition[];
}
export interface GroupBoardDataset {
  schemaVersion: 1;
  dataSource: "synthetic" | "local-materialized";
  observedAt: string;
  boards: Partial<
    Record<GroupBoardPeriod, { periodLabel: string; windowStartSec: number; rows: GroupBoardFact[] }>
  >;
}
export type GroupBoardEntry = Omit<GroupBoardFact, "positions"> & {
  rank: number;
  positionsCount: number;
  topPositions: Omit<GroupBoardPosition, "valueUsd">[];
};
export interface GroupBoard {
  entries: GroupBoardEntry[];
  periodType: 0 | 1 | 2 | 3;
  periodLabel: string;
  windowStartSec: number;
  totalRanked: number;
}
export class UnavailableGroupBoardError extends Error {}

const periods: readonly string[] = ["daily", "weekly", "monthly"];
const sorts: readonly string[] = ["realized", "unrealized", "combined"];
/** Captured contract: 0 unspecified, 1 weekly, 2 monthly, 3 daily. */
const PERIOD_TYPE: Record<GroupBoardPeriod, 1 | 2 | 3> = { daily: 3, weekly: 1, monthly: 2 };
const MEASURES = [
  "pnlSol", "pnlUsd", "pnlPercent", "buySpendSol", "realizedPnlSol",
  "realizedPnlUsd", "unrealizedPnlSol", "unrealizedPnlUsd",
] as const;
const ROW_KEYS = [
  "groupId", "memberCount", "membersCounted", "username", "profileImageUrl",
  "isVerified", "verifiedBadgeVisible", "lastRefreshedAtMs", "positions", ...MEASURES,
];
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_POSITIONS = 1_000;

function invalid(field: string): never {
  throw new TypeError(`Invalid local group board dataset: ${field}`);
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
function count(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(field);
  return value as number;
}
function list(value: unknown, max: number, field: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(field);
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) invalid(field);
  }
  return value;
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
export function isGroupBoardPeriod(value: string | undefined): value is GroupBoardPeriod {
  return value !== undefined && periods.includes(value);
}
export function isGroupBoardSort(value: string | undefined): value is GroupBoardSort {
  return value !== undefined && sorts.includes(value);
}

interface StoredBoard {
  periodLabel: string;
  windowStartSec: number;
  rows: GroupBoardFact[];
}

/** Immutable, opt-in read model. No seeded boards, live data, bans or writes. */
export class GroupBoardStore {
  readonly dataSource: GroupBoardDataset["dataSource"];
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
      const groupIds = new Set<string>();
      const rows = list(board.rows, MAX_ROWS, "board.rows").map((value) => {
        const row = record(value, ROW_KEYS, "row");
        const groupId = text(row.groupId, "row.groupId");
        if (groupIds.has(groupId)) invalid("duplicate row");
        groupIds.add(groupId);
        const memberCount = count(row.memberCount, "row.memberCount");
        const membersCounted = count(row.membersCounted, "row.membersCounted");
        if (membersCounted > memberCount) invalid("row.membersCounted");
        if (typeof row.isVerified !== "boolean" || typeof row.verifiedBadgeVisible !== "boolean")
          invalid("row badge");
        const lastRefreshedAtMs = count(row.lastRefreshedAtMs, "row.lastRefreshedAtMs");
        if (lastRefreshedAtMs > observedAtMs) invalid("row.lastRefreshedAtMs");
        const mints = new Set<string>();
        const positions = list(row.positions, MAX_POSITIONS, "row.positions").map((item) => {
          const position = record(
            item,
            ["mint", "chainId", "symbol", "name", "imageUri", "valueUsd"],
            "position",
          );
          const mint = text(position.mint, "position.mint");
          const chainId = count(position.chainId, "position.chainId");
          const key = JSON.stringify([chainId, mint]);
          if (mints.has(key)) invalid("duplicate position");
          mints.add(key);
          return {
            mint,
            chainId,
            symbol: nullableText(position.symbol, "position.symbol"),
            name: nullableText(position.name, "position.name"),
            imageUri: nullableText(position.imageUri, "position.imageUri"),
            valueUsd: finite(position.valueUsd, "position.valueUsd"),
          };
        });
        // Largest fresh USD value first is declared; the mint/chain tie order is local.
        positions.sort((left, right) =>
          left.valueUsd !== right.valueUsd
            ? right.valueUsd - left.valueUsd
            : compare(left.mint, right.mint) || left.chainId - right.chainId,
        );
        const fact = {
          groupId,
          memberCount,
          membersCounted,
          username: nullableText(row.username, "row.username"),
          profileImageUrl: nullableText(row.profileImageUrl, "row.profileImageUrl"),
          isVerified: row.isVerified,
          verifiedBadgeVisible: row.verifiedBadgeVisible,
          lastRefreshedAtMs,
          positions,
        } as GroupBoardFact;
        for (const measure of MEASURES) fact[measure] = finite(row[measure], `row.${measure}`);
        return fact;
      });
      this.#boards.set(period, {
        periodLabel: text(board.periodLabel, "board.periodLabel"),
        windowStartSec,
        rows,
      });
    }
  }

  board(query: {
    period: GroupBoardPeriod;
    sort?: GroupBoardSort;
    limit?: number;
    positionsLimit?: number;
  }): GroupBoard {
    const { period, sort = "combined" } = query;
    if (
      !isGroupBoardPeriod(period) ||
      !isGroupBoardSort(sort) ||
      (query.limit !== undefined && !Number.isSafeInteger(query.limit)) ||
      (query.positionsLimit !== undefined &&
        (!Number.isSafeInteger(query.positionsLimit) || query.positionsLimit < 0))
    )
      throw new RangeError("Invalid group board query");
    const board = this.#boards.get(period);
    if (!board) throw new UnavailableGroupBoardError("No supplied group board");
    // Declared: rows default and ceiling 100, out-of-range clamps; icons default 3, above 5 clamp.
    const limit = Math.min(100, Math.max(0, query.limit ?? 100));
    const positionsLimit = Math.min(5, query.positionsLimit ?? 3);
    const measure = sort === "realized" ? "realizedPnlUsd" : sort === "unrealized" ? "unrealizedPnlUsd" : "pnlUsd";
    // Descending by the chosen measure; the groupId tie order is local policy.
    const ranked = [...board.rows].sort((left, right) =>
      left[measure] !== right[measure]
        ? right[measure] - left[measure]
        : compare(left.groupId, right.groupId),
    );
    return {
      entries: ranked.slice(0, limit).map(({ positions, ...row }, index) => ({
        rank: index + 1,
        ...row,
        positionsCount: positions.length,
        topPositions: positions
          .slice(0, positionsLimit)
          .map(({ valueUsd: _valueUsd, ...position }) => position),
      })),
      periodType: PERIOD_TYPE[period],
      periodLabel: board.periodLabel,
      windowStartSec: board.windowStartSec,
      totalRanked: ranked.length,
    };
  }
}

/** Startup-only, bounded regular-file read. No writes, reloads or network. */
export function loadGroupBoardStore(
  path: string | undefined,
  noFollow: number | undefined = constants.O_NOFOLLOW,
): GroupBoardStore | undefined {
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
    return new GroupBoardStore(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))),
    );
  } finally {
    closeSync(fd);
  }
}
