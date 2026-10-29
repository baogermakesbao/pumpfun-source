import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { validateAgainstSchema, type SchemaNode, type SchemaRoot } from "./schema-validator.js";

/** Offset sorts with a supplied (TOP/LATEST/LOWEST_ENTRY) or declared (CLOSED_PNL) order. */
export type MintPositionsSort = "LATEST" | "TOP" | "LOWEST_ENTRY" | "CLOSED_PNL";
export type OpenSort = Exclude<MintPositionsSort, "CLOSED_PNL">;

/** Local input: an OpenAPI 0.294.0 spot holder row plus its registry profile. */
export interface MintHolderFact {
  row: Record<string, unknown>;
  /** Served only with includeProfile=true; null for a wallet-only holder. */
  profile: Record<string, unknown> | null;
}
export interface MintPositionsDataset {
  schemaVersion: 1;
  dataSource: "synthetic" | "local-materialized";
  observedAt: string;
  mints: Record<
    string,
    {
      open: MintHolderFact[];
      /** Producer order per sort, as indices into `open`. An absent sort is unavailable. */
      orders: Partial<Record<OpenSort, number[]>>;
      /** Fully exited holders; null when closed positions were not materialized. */
      closed: MintHolderFact[] | null;
    }
  >;
}
export interface MintPositionsQuery {
  sortBy: MintPositionsSort;
  page?: number;
  pageSize?: number;
  withThesis?: boolean;
  updatesLimit?: number;
  includeProfile?: boolean;
}
export interface MintPositionsPage {
  positions: Record<string, unknown>[];
  totalCount: number;
  hasMore: boolean;
}
export class UnavailableMintPositionsError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const OPEN_SORTS: readonly string[] = ["LATEST", "TOP", "LOWEST_ENTRY"];
/** Local default; the declared ceiling is 50. */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 50;
/** Declared: omitted serves 5, at most 20, 0 skips update enrichment. */
const DEFAULT_UPDATES = 5;
const MAX_UPDATES = 20;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_MINTS = 10_000;
const MAX_HOLDERS = 10_000;
/** Non-spot or RANKED-only row fields this spot offset slice never serves. */
const NON_SPOT_KEYS = ["chain", "assetClass", "perp", "recommendationId", "recommendationRank", "profile"];

const spec = JSON.parse(
  new TextDecoder("utf-8", { fatal: true }).decode(
    readFileSync(new URL("../../../contracts/developer.openapi.json", import.meta.url)),
  ),
) as SchemaRoot & { paths: Record<string, any> };
const rowSchema: SchemaNode =
  spec.paths["/mint-positions/{mint}"].get.responses["200"].content["application/json"].schema
    .properties.positions.items;

function invalid(field: string): never {
  throw new TypeError(`Invalid local mint positions dataset: ${field}`);
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
/** Declared: hasLiked and hasReposted are null until a viewer is known; the API host has none. */
function viewerless(callout: unknown, depth = 0): boolean {
  if (!plain(callout)) return true;
  if (["hasLiked", "hasReposted"].some((key) => Object.hasOwn(callout, key) && callout[key] !== null))
    return false;
  const quoted = callout.quotedCallout;
  if (!plain(quoted)) return true;
  // Declared: a quoted callout is one level deep.
  if (depth > 0) return false;
  return viewerless(quoted.callout, depth + 1);
}
function hasThesis(row: Record<string, unknown>): boolean {
  const callout = row.callout as Record<string, unknown> | null;
  return callout !== null && typeof callout.thesis === "string" && callout.thesis.trim() !== "";
}

interface StoredMint {
  open: MintHolderFact[];
  orders: Partial<Record<OpenSort, number[]>>;
  closed: MintHolderFact[] | null;
}

/** Immutable, opt-in read model. No ranking, dust floor, non-spot chains, pairs or writes. */
export class MintPositionsStore {
  readonly dataSource: MintPositionsDataset["dataSource"];
  readonly observedAt: string;
  readonly #mints = new Map<string, StoredMint>();

  constructor(input: unknown) {
    const data = record(input, ["schemaVersion", "dataSource", "observedAt", "mints"], "root");
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

    if (!plain(data.mints)) invalid("mints");
    const mintKeys = Object.keys(data.mints);
    if (mintKeys.length > MAX_MINTS) invalid("mints");
    for (const mint of mintKeys) {
      text(mint, "mint");
      const entry = record(data.mints[mint], ["open", "orders", "closed"], "mint entry");
      const holders = (value: unknown, field: string, closed: boolean): MintHolderFact[] => {
        const keys = new Set<string>();
        return list(value, MAX_HOLDERS, field).map((item) => {
          const fact = record(item, ["row", "profile"], `${field}.holder`);
          // Snapshot, then check the pinned closed row shape (with its profile) before serving it.
          const row = structuredClone(fact.row) as Record<string, unknown>;
          const profile = structuredClone(fact.profile) as Record<string, unknown> | null;
          if (!plain(row) || NON_SPOT_KEYS.some((key) => Object.hasOwn(row, key))) invalid(`${field}.row`);
          if (profile !== null && !plain(profile)) invalid(`${field}.profile`);
          if (validateAgainstSchema({ ...row, profile }, rowSchema, "$", spec).length)
            invalid(`${field}.row`);
          if (row.coinMint !== mint) invalid(`${field}.row.coinMint`);
          if (!viewerless(row.callout)) invalid(`${field}.row.callout`);
          const updates = (row.callout as { updates?: unknown[] } | null)?.updates ?? [];
          if (updates.length > MAX_UPDATES) invalid(`${field}.row.callout.updates`);
          if (closed !== (row.amountHeld === 0)) invalid(`${field}.row.amountHeld`);
          // Declared: positions are keyed (wallet, mint, chain), never by userId alone.
          const key = JSON.stringify([row.walletAddress, row.chainId]);
          if (keys.has(key)) invalid(`${field}.duplicate holder`);
          keys.add(key);
          return { row, profile };
        });
      };
      const open = holders(entry.open, "open", false);
      if (!plain(entry.orders) || Object.keys(entry.orders).some((key) => !OPEN_SORTS.includes(key)))
        invalid("orders");
      const orders: Partial<Record<OpenSort, number[]>> = {};
      for (const [sort, value] of Object.entries(entry.orders)) {
        const indices = list(value, MAX_HOLDERS, `orders.${sort}`);
        if (
          indices.some((index) => !Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= open.length) ||
          new Set(indices).size !== indices.length ||
          // TOP and LATEST order every open holder; LOWEST_ENTRY's dust floor may drop some.
          (sort !== "LOWEST_ENTRY" && indices.length !== open.length)
        )
          invalid(`orders.${sort}`);
        orders[sort as OpenSort] = [...(indices as number[])];
      }
      const closed = entry.closed === null ? null : holders(entry.closed, "closed", true);
      if (closed) {
        // Declared: realized PnL USD descending, losses last; the wallet/chain tie order is local.
        closed.sort(
          ({ row: left }, { row: right }) =>
            (right.realizedPnlUsd as number) - (left.realizedPnlUsd as number) ||
            compare(JSON.stringify([left.walletAddress, left.chainId]), JSON.stringify([right.walletAddress, right.chainId])),
        );
      }
      this.#mints.set(mint, { open, orders, closed });
    }
  }

  page(mint: string, query: MintPositionsQuery): MintPositionsPage {
    const {
      sortBy,
      page = 0,
      pageSize = DEFAULT_PAGE_SIZE,
      withThesis = false,
      updatesLimit = DEFAULT_UPDATES,
      includeProfile = false,
    } = query;
    if (
      !["LATEST", "TOP", "LOWEST_ENTRY", "CLOSED_PNL"].includes(sortBy) ||
      !Number.isSafeInteger(page) || page < 0 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE ||
      !Number.isSafeInteger(updatesLimit) || updatesLimit < 0 || updatesLimit > MAX_UPDATES ||
      typeof withThesis !== "boolean" ||
      typeof includeProfile !== "boolean" ||
      // Declared: CLOSED_PNL requires withThesis=true.
      (sortBy === "CLOSED_PNL" && !withThesis)
    )
      throw new RangeError("Invalid mint positions query");
    const stored = this.#mints.get(mint);
    if (!stored) throw new UnavailableMintPositionsError("MINT_POSITIONS_UNAVAILABLE");
    let ordered: MintHolderFact[];
    let totalCount: number;
    if (sortBy === "CLOSED_PNL") {
      if (!stored.closed) throw new UnavailableMintPositionsError("CLOSED_POSITIONS_UNAVAILABLE");
      ordered = stored.closed;
      // Declared: counts the closed holders that have a callout for this mint.
      totalCount = stored.closed.filter(({ row }) => row.callout !== null).length;
    } else {
      const order = stored.orders[sortBy];
      if (!order) throw new UnavailableMintPositionsError("SORT_ORDER_UNAVAILABLE");
      ordered = order.map((index) => stored.open[index]);
      // Declared: the open sorts count the mint's open holders.
      totalCount = stored.open.length;
    }
    // Declared: the thesis filter applies before paging.
    const visible = withThesis ? ordered.filter(({ row }) => hasThesis(row)) : ordered;
    const served = visible.slice(page * pageSize, page * pageSize + pageSize);
    return {
      positions: served.map(({ row, profile }) => {
        const out = structuredClone(row);
        const callout = out.callout as { updates: unknown[] } | null;
        if (callout) callout.updates = callout.updates.slice(0, updatesLimit);
        if (includeProfile) out.profile = structuredClone(profile);
        return out;
      }),
      totalCount,
      // Declared: offset sorts derive hasMore from totalCount; always false on an empty page.
      hasMore: served.length > 0 && (page + 1) * pageSize < totalCount,
    };
  }
}

/** Startup-only, bounded regular-file read. No writes, reloads or network. */
export function loadMintPositionsStore(
  path: string | undefined,
  noFollow: number | undefined = constants.O_NOFOLLOW,
): MintPositionsStore | undefined {
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
    return new MintPositionsStore(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))),
    );
  } finally {
    closeSync(fd);
  }
}
