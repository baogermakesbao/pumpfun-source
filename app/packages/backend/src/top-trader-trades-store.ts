import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";

export type TopTraderPeriod = "daily" | "weekly" | "monthly";

/** Local inputs, not a recovered database schema or a board computation. */
export interface TopTraderFact {
  userId: string;
  walletAddress: string;
  username: string | null;
  profileImage: string | null;
  isVerified: boolean;
  verifiedBadgeVisible: boolean;
  bestRank: number;
  periods: TopTraderPeriod[];
}
export interface TopTraderTrade {
  tx: string;
  isBuy: boolean;
  timestamp: string | null;
  amountUsd: number | null;
  baseAmount: number | null;
  priceUsd: number | null;
  mint: string;
  chainId: number;
  walletAddress: string;
  userId: string;
  slotIndexId: string;
  amountSol: number | null;
}
export interface TopTraderTradesDataset {
  schemaVersion: 1;
  dataSource: "synthetic" | "local-materialized";
  observedAt: string;
  boardsBuiltAtMs: number;
  generatedAtMs: number;
  traders: TopTraderFact[];
  trades: TopTraderTrade[];
}
export interface TopTraderView extends TopTraderFact {
  tradingWallets: string[];
  tradeCount: number;
}
export interface TopTraderTradesPage {
  mint: string;
  traders: TopTraderView[];
  trades: TopTraderTrade[];
  boardsBuiltAtMs: number;
  generatedAtMs: number;
  page: { nextCursor: string | null; to: number | null; limit: number } | null;
}
export interface TopTraderTradesQuery {
  chainId?: number;
  to?: number;
  cursor?: string;
  limit?: number;
}
export class AmbiguousMintChainError extends Error {}

const periods: readonly string[] = ["daily", "weekly", "monthly"];
/** Declared: trades per page, default and ceiling 500. */
const MAX_LIMIT = 500;
/** Declared: top 50 of any period. */
const TOP_RANK = 50;
const CURSOR = /^s:([0-9]{26})$/;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TRADERS = 10_000;
const MAX_TRADES = 200_000;

function invalid(field: string): never {
  throw new TypeError(`Invalid local top-trader trades dataset: ${field}`);
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
function nullableFinite(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(field);
  return value;
}
function instantMs(value: unknown, field: string): number {
  const result = text(value, field);
  const ms = Date.parse(result);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) ||
    !Number.isFinite(ms) ||
    new Date(ms).toISOString() !== result
  )
    invalid(field);
  return ms;
}
function epochMs(value: unknown, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum)
    invalid(field);
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

interface StoredTrade {
  trade: TopTraderTrade;
  atMs: number | null;
}

/** Immutable, opt-in read model. No seeded boards, live trades, bans or writes. */
export class TopTraderTradesStore {
  readonly dataSource: TopTraderTradesDataset["dataSource"];
  readonly observedAt: string;
  readonly #boardsBuiltAtMs: number;
  readonly #generatedAtMs: number;
  readonly #traders = new Map<string, TopTraderFact>();
  /** Trades by mint, newest (highest slotIndexId) first. */
  readonly #trades = new Map<string, StoredTrade[]>();

  constructor(input: unknown) {
    const data = record(
      input,
      ["schemaVersion", "dataSource", "observedAt", "boardsBuiltAtMs", "generatedAtMs", "traders", "trades"],
      "root",
    );
    if (
      data.schemaVersion !== 1 ||
      (data.dataSource !== "synthetic" && data.dataSource !== "local-materialized")
    )
      invalid("version/source");
    this.dataSource = data.dataSource;
    const observedAtMs = instantMs(data.observedAt, "observedAt");
    this.observedAt = data.observedAt as string;
    this.#boardsBuiltAtMs = epochMs(data.boardsBuiltAtMs, observedAtMs, "boardsBuiltAtMs");
    this.#generatedAtMs = epochMs(data.generatedAtMs, observedAtMs, "generatedAtMs");
    if (this.#generatedAtMs < this.#boardsBuiltAtMs) invalid("generatedAtMs");

    for (const value of list(data.traders, MAX_TRADERS, "traders")) {
      const row = record(
        value,
        ["userId", "walletAddress", "username", "profileImage", "isVerified", "verifiedBadgeVisible", "bestRank", "periods"],
        "trader",
      );
      const userId = text(row.userId, "trader.userId");
      if (this.#traders.has(userId)) invalid("duplicate trader");
      if (typeof row.isVerified !== "boolean" || typeof row.verifiedBadgeVisible !== "boolean")
        invalid("trader badge");
      if (
        !Number.isSafeInteger(row.bestRank) ||
        (row.bestRank as number) < 1 ||
        (row.bestRank as number) > TOP_RANK
      )
        invalid("trader.bestRank");
      const ranked = list(row.periods, periods.length, "trader.periods");
      // Declared "in period order": a non-empty, strictly ordered subset.
      if (
        !ranked.length ||
        ranked.some(
          (period, index) =>
            typeof period !== "string" ||
            !periods.includes(period) ||
            (index > 0 && periods.indexOf(period) <= periods.indexOf(ranked[index - 1] as string)),
        )
      )
        invalid("trader.periods");
      this.#traders.set(userId, {
        userId,
        walletAddress: text(row.walletAddress, "trader.walletAddress"),
        username: nullableText(row.username, "trader.username"),
        profileImage: nullableText(row.profileImage, "trader.profileImage"),
        isVerified: row.isVerified,
        verifiedBadgeVisible: row.verifiedBadgeVisible,
        bestRank: row.bestRank as number,
        periods: [...ranked] as TopTraderPeriod[],
      });
    }

    const slots = new Set<string>();
    for (const value of list(data.trades, MAX_TRADES, "trades")) {
      const row = record(
        value,
        ["tx", "isBuy", "timestamp", "amountUsd", "baseAmount", "priceUsd", "mint", "chainId", "walletAddress", "userId", "slotIndexId", "amountSol"],
        "trade",
      );
      const slotIndexId = row.slotIndexId;
      if (typeof slotIndexId !== "string" || !/^[0-9]{26}$/.test(slotIndexId))
        invalid("trade.slotIndexId");
      if (slots.has(slotIndexId)) invalid("duplicate trade");
      slots.add(slotIndexId);
      const userId = text(row.userId, "trade.userId");
      if (!this.#traders.has(userId)) invalid("trade without top trader");
      if (typeof row.isBuy !== "boolean") invalid("trade.isBuy");
      if (!Number.isSafeInteger(row.chainId)) invalid("trade.chainId");
      const atMs = row.timestamp === null ? null : instantMs(row.timestamp, "trade.timestamp");
      if (atMs !== null && atMs > observedAtMs) invalid("trade.timestamp");
      const trade: TopTraderTrade = {
        tx: text(row.tx, "trade.tx"),
        isBuy: row.isBuy,
        timestamp: row.timestamp as string | null,
        amountUsd: nullableFinite(row.amountUsd, "trade.amountUsd"),
        baseAmount: nullableFinite(row.baseAmount, "trade.baseAmount"),
        priceUsd: nullableFinite(row.priceUsd, "trade.priceUsd"),
        mint: text(row.mint, "trade.mint"),
        chainId: row.chainId as number,
        walletAddress: text(row.walletAddress, "trade.walletAddress"),
        userId,
        slotIndexId,
        amountSol: nullableFinite(row.amountSol, "trade.amountSol"),
      };
      let bucket = this.#trades.get(trade.mint);
      if (!bucket) this.#trades.set(trade.mint, (bucket = []));
      bucket.push({ trade, atMs });
    }
    for (const bucket of this.#trades.values()) {
      // slotIndexId is the declared chain-ordered identity; zero padding makes it sortable.
      bucket.sort((left, right) => compare(right.trade.slotIndexId, left.trade.slotIndexId));
      let later: number | null = null;
      for (const { atMs } of bucket) {
        if (atMs === null) continue;
        if (later !== null && atMs > later) invalid("timestamps out of chain order");
        later = atMs;
      }
    }
  }

  trades(mint: string, query: TopTraderTradesQuery = {}): TopTraderTradesPage {
    const { chainId, to, cursor, limit } = query;
    if (
      (chainId !== undefined && !Number.isSafeInteger(chainId)) ||
      (to !== undefined && (!Number.isSafeInteger(to) || to < 0)) ||
      (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT)) ||
      (cursor !== undefined && !CURSOR.test(cursor))
    )
      throw new RangeError("Invalid top-trader trades query");
    let candidates = this.#trades.get(mint) ?? [];
    if (chainId !== undefined) candidates = candidates.filter(({ trade }) => trade.chainId === chainId);
    else if (new Set(candidates.map(({ trade }) => trade.chainId)).size > 1)
      throw new AmbiguousMintChainError("The mint spans several chains");
    // An undated fill cannot be placed relative to `to`, so it is not served under one.
    if (to !== undefined) candidates = candidates.filter(({ atMs }) => atMs !== null && atMs <= to);
    if (cursor !== undefined) {
      const after = CURSOR.exec(cursor)![1];
      candidates = candidates.filter(({ trade }) => trade.slotIndexId < after);
    }
    const size = limit ?? MAX_LIMIT;
    const served = candidates.slice(0, size).map(({ trade }) => ({ ...trade }));
    const more = candidates.length > size;
    const paged = to !== undefined || cursor !== undefined || limit !== undefined || more;

    const byTrader = new Map<string, { wallets: Set<string>; count: number }>();
    for (const trade of served) {
      let entry = byTrader.get(trade.userId);
      if (!entry) byTrader.set(trade.userId, (entry = { wallets: new Set(), count: 0 }));
      entry.wallets.add(trade.walletAddress);
      entry.count += 1;
    }
    const traders = [...byTrader]
      .map(([userId, { wallets, count }]) => {
        const fact = this.#traders.get(userId)!;
        return {
          ...fact,
          periods: [...fact.periods],
          tradingWallets: [...wallets].sort(compare),
          tradeCount: count,
        };
      })
      // Best rank first is declared; the userId tie order is local.
      .sort((left, right) => left.bestRank - right.bestRank || compare(left.userId, right.userId));

    return {
      mint,
      traders,
      trades: served,
      boardsBuiltAtMs: this.#boardsBuiltAtMs,
      generatedAtMs: this.#generatedAtMs,
      page: paged
        ? {
            nextCursor: more ? `s:${served[served.length - 1].slotIndexId}` : null,
            to: to ?? null,
            limit: size,
          }
        : null,
    };
  }
}

/** Startup-only, bounded regular-file read. No writes, reloads or network. */
export function loadTopTraderTradesStore(
  path: string | undefined,
  noFollow: number | undefined = constants.O_NOFOLLOW,
): TopTraderTradesStore | undefined {
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
    return new TopTraderTradesStore(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))),
    );
  } finally {
    closeSync(fd);
  }
}
