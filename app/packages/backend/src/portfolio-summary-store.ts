import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { validateAgainstSchema, type SchemaNode, type SchemaRoot } from "./schema-validator.js";

export const PERIODS = ["1d", "1w", "1m", "all"] as const;
export type Period = (typeof PERIODS)[number];
type Body = Record<string, unknown>;

/** One served identity: precomputed OpenAPI 0.294.0 bodies per period; null = that window failed. */
export interface PortfolioSummarySubject {
  kind: "wallet" | "group";
  periods: Partial<Record<Period, Body | null>>;
}
export interface PortfolioSummaryDataset {
  schemaVersion: 1;
  dataSource: "synthetic" | "local-materialized";
  observedAt: string;
  /** Keyed by the exact `user` query value: wallet, username, NEAR/Starknet account, group id or name. */
  subjects: Record<string, PortfolioSummarySubject>;
}

const spec = JSON.parse(
  new TextDecoder("utf-8", { fatal: true }).decode(
    readFileSync(new URL("../../../contracts/developer.openapi.json", import.meta.url)),
  ),
) as SchemaRoot & { paths: Record<string, any> };
const [walletSchema, groupSchema] = spec.paths["/portfolio-summary"].get.responses["200"].content[
  "application/json"
].schema.anyOf as SchemaNode[];

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SUBJECTS = 10_000;
const PNL_LEGS = [
  "pnl",
  "realizedPnl",
  "unrealizedPnl",
  "percentage",
  "totalBuySpend",
  "heldOpenValue",
  "maxCapitalDeployed",
  "equityAtWindowStart",
  "tradePercentage",
] as const;
const WINDOW_KEYS = ["from", "to", ...PNL_LEGS, "missingPriceMints"] as const;
const IDENTITY_BUCKETS = [
  "solUsd",
  "perpsUsd",
  "evmNativeUsd",
  "psHiddenUsd",
  "spamGroupedUsd",
  "hiddenStablesUsd",
  "subCentUsd",
] as const;

export class PortfolioSummaryUnavailable extends Error {}

function invalid(field: string): never {
  throw new TypeError(`Invalid local portfolio summary dataset: ${field}`);
}
function plain(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}
function nonNegativeInteger(value: unknown, field: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(field);
}

/** Declared invariants of one wallet or group body that the structural schema cannot express. */
function checkBody(body: Body, kind: PortfolioSummarySubject["kind"], user: string, period: Period, observedAtMs: number): void {
  if (validateAgainstSchema(body, kind === "wallet" ? walletSchema : groupSchema, "$", spec).length) invalid("body");
  if ((body.from as number) > (body.to as number)) invalid("from/to");
  const cache = body.cache as Body;
  // The API host is never an owner: every caller is served the cached body.
  if (Object.hasOwn(cache, "fresh")) invalid("cache.fresh");
  if ((cache.filledAtMs as number) > observedAtMs || (cache.ttlSeconds as number) < 0) invalid("cache");
  // A Starknet address answers `all` with null pnl and realizedPnl.
  if (period === "all" && /^0x[0-9a-fA-F]{64}$/.test(user))
    for (const leg of ["pnl", "realizedPnl"])
      if ((body[leg] as Body).sol !== null || (body[leg] as Body).usd !== null) invalid(`${leg} (Starknet all)`);
  if (kind === "group") {
    nonNegativeInteger(body.memberCount, "memberCount");
    nonNegativeInteger(body.membersIncluded, "membersIncluded");
    return;
  }
  // `windows` is built from the subject's own period bodies, never supplied.
  if (Object.hasOwn(body, "windows")) invalid("windows");
  if ((body.computedAt as number) > observedAtMs) invalid("computedAt");
  if (body.tokenCount === null) {
    // The balance leg serves alone: every PnL leg null, totalValueUsd served.
    for (const leg of PNL_LEGS)
      if ((body[leg] as Body).sol !== null || (body[leg] as Body).usd !== null) invalid(`${leg} (no PnL leg)`);
    if (body.totalValueUsd === null) invalid("totalValueUsd (no PnL leg)");
  } else nonNegativeInteger(body.tokenCount, "tokenCount");
  if (typeof body.evmAddress === "string" && !/^0x[0-9a-f]{40}$/.test(body.evmAddress)) invalid("evmAddress");

  const holdings = body.holdings as Body[] | null | undefined;
  const reprice = body.reprice as Body | null | undefined;
  if (Array.isArray(holdings)) {
    if (holdings.length > 25) invalid("holdings");
    for (const row of holdings)
      if (((row.markUsd ?? null) === null) !== ((row.markSource ?? null) === null)) invalid("holdings.markSource");
  }
  if (reprice === null && Array.isArray(holdings)) invalid("reprice (holdings unavailable)");
  if (plain(reprice)) {
    if (!Array.isArray(holdings)) invalid("reprice (holdings unavailable)");
    if ((reprice.asOf as number) > observedAtMs) invalid("reprice.asOf");
    nonNegativeInteger(reprice.depth, "reprice.depth");
    if (holdings.length > (reprice.depth as number)) invalid("holdings (past depth)");
    if ((reprice.unrepriced as unknown[]).length > 50) invalid("reprice.unrepriced");
    if ((reprice.plane === "none") !== (reprice.reason !== null)) invalid("reprice.reason");
  }
  const identity = body.identity as Body | null | undefined;
  if (plain(identity)) {
    const reasons = identity.reasons as Record<string, string>;
    const nullBuckets = IDENTITY_BUCKETS.filter((bucket) => identity[bucket] === null) as string[];
    if (plain(reprice) && reprice.tailValueUsd === null) nullBuckets.push("tailValueUsd");
    // A bucket the server cannot compute is null with a reason, never 0.
    for (const bucket of nullBuckets) if (!reasons[bucket]?.trim()) invalid(`identity.reasons.${bucket}`);
  }
}

export interface SummaryQuery {
  user: string;
  period: Period;
  periods?: Period[];
  holdings: boolean;
}

/** Immutable, opt-in read model. No PnL engine, pricing, identity resolution, refresh or writes. */
export class PortfolioSummaryStore {
  readonly dataSource: PortfolioSummaryDataset["dataSource"];
  readonly observedAt: string;
  readonly #subjects = new Map<string, { kind: PortfolioSummarySubject["kind"]; periods: Map<Period, string | null> }>();

  constructor(input: unknown) {
    if (!plain(input)) invalid("root");
    const keys = ["schemaVersion", "dataSource", "observedAt", "subjects"];
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

    const subjects = input.subjects;
    if (!plain(subjects) || Object.keys(subjects).length > MAX_SUBJECTS) invalid("subjects");
    for (const [user, subject] of Object.entries(subjects)) {
      // Longer or empty values cannot be requested.
      if (!user.length || user.length > 66) invalid("subject key");
      if (!plain(subject) || Object.keys(subject).length !== 2 || !plain(subject.periods)) invalid("subject");
      const kind = subject.kind;
      if (kind !== "wallet" && kind !== "group") invalid("subject.kind");
      const periods = new Map<Period, string | null>();
      let owner: unknown;
      for (const [period, body] of Object.entries(subject.periods)) {
        if (!(PERIODS as readonly string[]).includes(period)) invalid("period");
        if (body !== null) {
          if (!plain(body)) invalid("body");
          checkBody(body, kind, user, period as Period, observedAtMs);
          // Every window of one identity serves the same wallet or group.
          const served = kind === "wallet" ? body.wallet : body.groupId;
          if (owner !== undefined && served !== owner) invalid(kind === "wallet" ? "wallet" : "groupId");
          owner = served;
        }
        periods.set(period as Period, body === null ? null : JSON.stringify(body));
      }
      this.#subjects.set(user, { kind, periods });
    }
  }

  /** The served body, or PortfolioSummaryUnavailable when any requested window was not materialized. */
  summary({ user, period, periods, holdings }: SummaryQuery): Body {
    const subject = this.#subjects.get(user);
    const top = subject?.periods.get(period);
    if (!subject || top === undefined || top === null) throw new PortfolioSummaryUnavailable();
    const body = JSON.parse(top) as Body;
    if (subject.kind === "group") return body;
    if (holdings) body.holdings ??= null;
    else {
      delete body.holdings;
      delete body.reprice;
    }
    if (periods) {
      const windows: Record<string, Body | null> = {};
      for (const each of periods) {
        const stored = subject.periods.get(each);
        if (stored === undefined) throw new PortfolioSummaryUnavailable();
        const source = stored === null ? null : (JSON.parse(stored) as Body);
        windows[each] = source && Object.fromEntries(WINDOW_KEYS.map((key) => [key, source[key]]));
      }
      body.windows = windows;
    }
    return body;
  }
}

/** Startup-only, bounded regular-file read. No writes, reloads or network. */
export function loadPortfolioSummaryStore(
  path: string | undefined,
  noFollow: number | undefined = constants.O_NOFOLLOW,
): PortfolioSummaryStore | undefined {
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
    return new PortfolioSummaryStore(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))),
    );
  } finally {
    closeSync(fd);
  }
}
