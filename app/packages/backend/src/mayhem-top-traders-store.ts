import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";

/** Local input: one OpenAPI 0.294.0 trader row as the producer ranked it. */
export interface MayhemTrader {
  rank: number;
  address: string;
  username: string | null;
  profileImage: string | null;
  realisedPnlUsd: number;
  averageEntryMarketCapUsd: number | null;
  averageExitMarketCapUsd: number | null;
  totalBoughtUsd: number;
  totalSoldUsd: number;
  buyTransactionCount: number;
  sellTransactionCount: number;
  /** Raw token amount; may exceed Number.MAX_SAFE_INTEGER. */
  tokenBalance: string;
  tokenAmountBought: number;
  tokenAmountSold: number;
  /** Epoch seconds. */
  lastActivityAt: number;
}
export interface MayhemTopTradersDataset {
  schemaVersion: 1;
  dataSource: "synthetic" | "local-materialized";
  observedAt: string;
  /** Per mint, a snapshot taken at `updatedAt` (epoch ms) of the ranked board. */
  boards: Record<string, { updatedAt: number; traders: MayhemTrader[] }>;
}
export interface MayhemTopTraders {
  mint: string;
  updatedAt: number;
  traders: MayhemTrader[];
}
export class UnavailableMayhemBoardError extends Error {}

const TRADER_KEYS = [
  "rank", "address", "username", "profileImage", "realisedPnlUsd", "averageEntryMarketCapUsd",
  "averageExitMarketCapUsd", "totalBoughtUsd", "totalSoldUsd", "buyTransactionCount",
  "sellTransactionCount", "tokenBalance", "tokenAmountBought", "tokenAmountSold", "lastActivityAt",
] as const;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_BOARDS = 10_000;
const MAX_TRADERS = 10_000;

function invalid(field: string): never {
  throw new TypeError(`Invalid local mayhem top-traders dataset: ${field}`);
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
function nullableText(value: unknown, field: string): string | null {
  return value === null ? null : text(value, field);
}
function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(field);
  return value;
}
function amount(value: unknown, field: string): number {
  const parsed = finite(value, field);
  if (parsed < 0) invalid(field);
  return parsed;
}
function nullableAmount(value: unknown, field: string): number | null {
  return value === null ? null : amount(value, field);
}
function count(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(field);
  return value as number;
}
/** Canonical non-negative decimal integer string, within uint256. */
function rawAmount(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,77})$/.test(value)) invalid(field);
  if (BigInt(value) >= 2n ** 256n) invalid(field);
  return value;
}
function list(value: unknown, max: number, field: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(field);
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) invalid(field);
  }
  return value;
}

/** Immutable, opt-in read model. No ranking, trade folding, live snapshots or writes. */
export class MayhemTopTradersStore {
  readonly dataSource: MayhemTopTradersDataset["dataSource"];
  readonly observedAt: string;
  readonly #boards = new Map<string, { updatedAt: number; traders: MayhemTrader[] }>();

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

    if (!plain(data.boards)) invalid("boards");
    const mints = Object.keys(data.boards);
    if (mints.length > MAX_BOARDS) invalid("boards");
    for (const mint of mints) {
      text(mint, "mint");
      const board = record(data.boards[mint], ["updatedAt", "traders"], "board");
      const updatedAt = count(board.updatedAt, "board.updatedAt");
      if (updatedAt > observedAtMs) invalid("board.updatedAt");
      const addresses = new Set<string>();
      let previousRank = 0;
      const traders = list(board.traders, MAX_TRADERS, "board.traders").map((value) => {
        const row = record(value, TRADER_KEYS, "trader");
        // The producer's ranking is served as-is: positive integers in supplied order, ties allowed.
        const rank = count(row.rank, "trader.rank");
        if (rank < 1 || rank < previousRank) invalid("trader.rank");
        previousRank = rank;
        const address = text(row.address, "trader.address");
        if (addresses.has(address)) invalid("duplicate trader");
        addresses.add(address);
        const trader: MayhemTrader = {
          rank,
          address,
          username: nullableText(row.username, "trader.username"),
          profileImage: nullableText(row.profileImage, "trader.profileImage"),
          realisedPnlUsd: finite(row.realisedPnlUsd, "trader.realisedPnlUsd"),
          averageEntryMarketCapUsd: nullableAmount(row.averageEntryMarketCapUsd, "trader.averageEntryMarketCapUsd"),
          averageExitMarketCapUsd: nullableAmount(row.averageExitMarketCapUsd, "trader.averageExitMarketCapUsd"),
          totalBoughtUsd: amount(row.totalBoughtUsd, "trader.totalBoughtUsd"),
          totalSoldUsd: amount(row.totalSoldUsd, "trader.totalSoldUsd"),
          buyTransactionCount: count(row.buyTransactionCount, "trader.buyTransactionCount"),
          sellTransactionCount: count(row.sellTransactionCount, "trader.sellTransactionCount"),
          tokenBalance: rawAmount(row.tokenBalance, "trader.tokenBalance"),
          tokenAmountBought: amount(row.tokenAmountBought, "trader.tokenAmountBought"),
          tokenAmountSold: amount(row.tokenAmountSold, "trader.tokenAmountSold"),
          lastActivityAt: count(row.lastActivityAt, "trader.lastActivityAt"),
        };
        // Activity in epoch seconds cannot follow the snapshot it is read from.
        if (trader.lastActivityAt * 1000 > updatedAt) invalid("trader.lastActivityAt");
        // Local consistency: a side with no transactions has no totals, amounts or average.
        if (
          trader.buyTransactionCount === 0 &&
          (trader.totalBoughtUsd !== 0 || trader.tokenAmountBought !== 0 || trader.averageEntryMarketCapUsd !== null)
        )
          invalid("trader.buy side");
        if (
          trader.sellTransactionCount === 0 &&
          (trader.totalSoldUsd !== 0 || trader.tokenAmountSold !== 0 || trader.averageExitMarketCapUsd !== null)
        )
          invalid("trader.sell side");
        return trader;
      });
      this.#boards.set(mint, { updatedAt, traders });
    }
  }

  board(mint: string): MayhemTopTraders {
    const board = this.#boards.get(mint);
    if (!board) throw new UnavailableMayhemBoardError("No supplied mayhem board");
    return { mint, updatedAt: board.updatedAt, traders: board.traders.map((trader) => ({ ...trader })) };
  }
}

/** Startup-only, bounded regular-file read. No writes, reloads or network. */
export function loadMayhemTopTradersStore(
  path: string | undefined,
  noFollow: number | undefined = constants.O_NOFOLLOW,
): MayhemTopTradersStore | undefined {
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
    return new MayhemTopTradersStore(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))),
    );
  } finally {
    closeSync(fd);
  }
}
