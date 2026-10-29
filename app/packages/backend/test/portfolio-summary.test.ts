import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildApp, type Fixture } from "../src/app.js";
import {
  PortfolioSummaryStore,
  loadPortfolioSummaryStore,
  type PortfolioSummaryDataset,
} from "../src/portfolio-summary-store.js";
import { assertSchema } from "../src/schema-validator.js";

const now = "2026-10-29T00:00:00.000Z";
const nowMs = Date.parse(now);
// Synthetic shape-only credential for in-process compatibility-gate tests.
const headers = { authorization: `Bearer pf_live_${"a".repeat(49)}` };
const spec = JSON.parse(
  readFileSync(new URL("../../../contracts/developer.openapi.json", import.meta.url), "utf8"),
);
const operation = spec.paths["/portfolio-summary"].get;
const okSchema = operation.responses["200"].content["application/json"].schema;
const badSchema = operation.responses["400"].content["application/json"].schema;

const WALLET = "Synthetic1111111111111111111111111";
const STARKNET = `0x${"ab".repeat(32)}`;
const pair = (sol: number | null, usd: number | null) => ({ sol, usd });
const LEGS = [
  "pnl",
  "realizedPnl",
  "unrealizedPnl",
  "percentage",
  "totalBuySpend",
  "heldOpenValue",
  "maxCapitalDeployed",
  "equityAtWindowStart",
  "tradePercentage",
];

function legs(seed: number): Record<string, unknown> {
  return {
    from: nowMs - seed * 1000,
    to: nowMs - 1000,
    ...Object.fromEntries(LEGS.map((leg, i) => [leg, pair(seed + i, seed * 10 + i)])),
    missingPriceMints: [`Missing${seed}`],
  };
}
function walletBody(seed: number): Record<string, any> {
  return {
    ...legs(seed),
    totalValueUsd: 1234.5,
    cache: { filledAtMs: nowMs - 2000, ttlSeconds: 30 },
    wallet: WALLET,
    tokenCount: 3,
    solPriceUsd: 150,
    nativeBalanceSol: 2.5,
    computedAt: nowMs - 2000,
    evmAddress: `0x${"ab01".repeat(10)}`,
    holdings: [
      { chain: "solana", mint: "HoldMint", amount: 10, priceUsd: 2, valueUsd: 20, marketCapUsd: null, markUsd: 1.9, markSource: "pnl_row", repriced: true, livePlane: "content_pairs" },
      { chain: "base", mint: "0xheld", amount: 1, priceUsd: 5, valueUsd: 5, marketCapUsd: 1e6, markUsd: null, markSource: null },
    ],
    reprice: {
      plane: "content_pairs",
      mode: "fill",
      asOf: nowMs - 2500,
      depth: 25,
      repricedRows: 1,
      deltaTotalUsd: 1,
      deltaPnlUsd: 0.5,
      tailValueUsd: null,
      capSuspectUsd: 0,
      unrepriced: [{ mint: "0xheld", chain: "base", reason: "no_pnl_row", contribUsd: 5 }],
      unrepricedUsd: 5,
      amountSkew: [],
      spamExcludedRows: 0,
      pnlUncoveredUsd: { "1d": 0, "1w": null, "1m": null, all: null },
      pnlPartial: { "1d": false, "1w": false, "1m": false, all: false },
      reason: null,
    },
    identity: {
      solUsd: 375,
      perpsUsd: null,
      evmNativeUsd: [{ chain: "base", usd: 12 }],
      psHiddenUsd: 0,
      spamGroupedUsd: 0,
      hiddenStablesUsd: 0,
      subCentUsd: 0,
      rowsRemark: "synthetic",
      reasons: { perpsUsd: "perps total unknown", tailValueUsd: "bucket not separable" },
    },
  };
}
function groupBody(seed: number): Record<string, any> {
  return {
    ...legs(seed),
    totalValueUsd: null,
    cache: { filledAtMs: nowMs - 2000, ttlSeconds: 60 },
    groupId: "group-1",
    memberCount: 5,
    membersIncluded: 4,
  };
}
function starknetBody(): Record<string, any> {
  const body = walletBody(9);
  delete body.holdings;
  delete body.reprice;
  delete body.identity;
  return { ...body, wallet: STARKNET, pnl: pair(null, null), realizedPnl: pair(null, null) };
}

function dataset(): PortfolioSummaryDataset {
  const bare = walletBody(3);
  delete bare.holdings;
  delete bare.reprice;
  return {
    schemaVersion: 1,
    dataSource: "synthetic",
    observedAt: now,
    subjects: {
      [WALLET]: { kind: "wallet", periods: { "1d": walletBody(1), "1w": walletBody(2), "1m": null, all: bare } },
      "squad-alpha": { kind: "group", periods: { "1d": groupBody(4), all: groupBody(5) } },
      [STARKNET]: { kind: "wallet", periods: { all: starknetBody() } },
    },
  };
}
function app(store?: PortfolioSummaryStore, fixtures: Fixture[] = []) {
  return buildApp(fixtures, store ? { portfolioSummaryStore: store } : {});
}
function get(server: ReturnType<typeof buildApp>, query: string) {
  return server.inject({ method: "GET", url: `/v1/portfolio-summary${query}`, headers });
}
function withoutHoldings(body: Record<string, any>) {
  const copy = structuredClone(body);
  delete copy.holdings;
  delete copy.reprice;
  return copy;
}

test("the declared contract text is the pinned captured range", () => {
  // Read and hash only; captured code is never imported or executed.
  const source = readFileSync(
    new URL("../../../evidence/web/objects/2b47dd0b38a1608f.js", import.meta.url),
    "utf8",
  );
  const factory = source.slice(316171, 329162);
  assert.equal(createHash("sha256").update(factory).digest("hex"), "083b87cb8275075285c47251672d79b06bc8db86196f12885a713f6a34134ad0");
  for (const phrase of [
    '"GET /portfolio-summary":(0,s.publicRead)("positions.read",{summary:"Merged Solana+EVM portfolio PnL for a wallet, username, or the authenticated user; a group id or group username serves the squad aggregate over active members"',
    "Omitted with an API key answers 400 API_USER_REQUIRED.",
    'periods:o.z.string().max(15).regex(/^(1d|1w|1m|all)(,(1d|1w|1m|all))*$/).optional().describe("Comma-separated periods, e.g. `1d,1w,1m,all` (1-4, duplicates collapsed, order kept)',
    "Anyone else, every API-host caller included, is served the cached body, never a 429",
    'holdings:o.z.boolean().optional().describe("Serve `holdings` (1/true): the balance leg\'s top 25 priced rows; omitted = no `holdings` key")',
    "response:o.z.union([w,f])",
    "null = that window was refused or failed, never zero legs. The `period` entry equals the top-level legs.",
    'fresh:o.z.boolean().optional().describe("true = this body was refilled for its owner\'s `fresh` read; absent otherwise")',
    "null when the PnL leg was unavailable and the balance leg serves alone (every PnL leg null, totalValueUsd served)",
    "Null exactly when markUsd is null",
    "N = reprice.depth",
    "a bucket the server cannot compute is null with a reason, never 0",
    "Why no reprice ran (error, timeout, breaker_open, holdings_null, truncated); null when it ran",
    "none = no reprice ran",
    "Up to 50 rows by contribUsd",
    "a NEAR account id or Starknet address answers all with null pnl and realizedPnl",
    'emits:["API_USER_REQUIRED"]',
  ])
    assert.ok(factory.includes(phrase), phrase);
});

test("a supplied wallet body is served for the exact user and period", async () => {
  const res = await get(app(new PortfolioSummaryStore(dataset())), `?user=${WALLET}&period=1w`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-reconstruction-data-source"], "synthetic");
  assert.equal(res.headers["x-reconstruction-observed-at"], now);
  assert.equal(res.headers["x-reconstruction-compatibility"], "unqualified");
  const body = res.json();
  assertSchema(body, okSchema, "wallet summary", spec);
  // Omitted holdings = no `holdings` key, and no reprice beside it.
  assert.deepEqual(body, withoutHoldings(walletBody(2)));
  assert.equal("windows" in body, false);
});

test("periods are served under windows: deduplicated, ordered, null when failed", async () => {
  const server = app(new PortfolioSummaryStore(dataset()));
  const res = await get(server, `?user=${WALLET}&period=1d&periods=all,1d,1m,all`);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assertSchema(body, okSchema, "windows", spec);
  assert.deepEqual(Object.keys(body.windows), ["all", "1d", "1m"]);
  assert.deepEqual(body.windows["1d"], legs(1));
  assert.deepEqual(body.windows.all, legs(3));
  assert.equal(body.windows["1m"], null);
  // The `period` entry equals the top-level legs.
  for (const key of Object.keys(body.windows["1d"])) assert.deepEqual(body.windows["1d"][key], body[key], key);
  // One window that was never materialized fails the whole read closed.
  const partial = await get(server, `?user=${STARKNET}&period=all&periods=all,1d`);
  assert.equal(partial.statusCode, 501);
});

test("holdings and reprice appear only when holdings is sent", async () => {
  const server = app(new PortfolioSummaryStore(dataset()));
  for (const flag of ["1", "true"]) {
    const res = await get(server, `?user=${WALLET}&period=1d&holdings=${flag}`);
    assert.equal(res.statusCode, 200, flag);
    assertSchema(res.json(), okSchema, `holdings=${flag}`, spec);
    assert.deepEqual(res.json(), walletBody(1), flag);
  }
  for (const flag of ["0", "false"]) {
    const res = await get(server, `?user=${WALLET}&period=1d&holdings=${flag}`);
    assert.deepEqual(res.json(), withoutHoldings(walletBody(1)), flag);
  }
  // A body stored without holdings answers holdings: null, never invented rows.
  const bare = (await get(server, `?user=${WALLET}&period=all&holdings=1`)).json();
  assertSchema(bare, okSchema, "bare holdings", spec);
  assert.equal(bare.holdings, null);
  assert.equal("reprice" in bare, false);
});

test("fresh is accepted and never refreshes on the API host", async () => {
  const server = app(new PortfolioSummaryStore(dataset()));
  const plainRead = (await get(server, `?user=${WALLET}&period=1d`)).json();
  for (const flag of ["1", "true", "0", "false"]) {
    const res = await get(server, `?user=${WALLET}&period=1d&fresh=${flag}`);
    assert.equal(res.statusCode, 200, flag);
    assert.deepEqual(res.json(), plainRead, flag);
    assert.equal("fresh" in res.json().cache, false, flag);
  }
});

test("a group serves its squad aggregate without wallet-only keys", async () => {
  const server = app(new PortfolioSummaryStore(dataset()));
  const res = await get(server, "?user=squad-alpha&period=all&periods=1d,all&holdings=1");
  assert.equal(res.statusCode, 200);
  assertSchema(res.json(), okSchema, "group summary", spec);
  assert.deepEqual(res.json(), groupBody(5));
});

test("a Starknet address is served its supplied all body", async () => {
  const res = await get(app(new PortfolioSummaryStore(dataset())), `?user=${STARKNET}&period=all`);
  assert.equal(res.statusCode, 200);
  assertSchema(res.json(), okSchema, "starknet", spec);
  assert.deepEqual(res.json().pnl, pair(null, null));
});

test("query parameters follow the declared contract", async () => {
  const server = app(new PortfolioSummaryStore(dataset()));
  const base = `user=${WALLET}&period=1d`;
  for (const query of [
    `?user=${WALLET}`,
    `?${base.replace("1d", "1y")}`,
    `?${base.replace("1d", "1D")}`,
    `?${base}&period=1w`,
    `?${base}&user=${WALLET}`,
    `?${base}&limit=10`,
    `?${base}&=`,
    `?${base}&periods=`,
    `?${base}&periods=1d,`,
    `?${base}&periods=1d,,1w`,
    `?${base}&periods=1d%201w`,
    `?${base}&periods=1d,1w,1m,all,all`, // 16 characters
    `?${base}&fresh=yes`,
    `?${base}&fresh=`,
    `?${base}&holdings=2`,
    `?${base}&holdings=TRUE`,
    "?user=&period=1d",
    `?user=${"x".repeat(67)}&period=1d`,
    "?period=1y", // validation runs before the user requirement
  ]) {
    const res = await get(server, query);
    assert.equal(res.statusCode, 400, query);
    assert.deepEqual(res.json(), { statusCode: 400, error: "INVALID_QUERY" }, query);
  }
  const accepted = await get(server, `?${base}&periods=1d,1w,1m,all,1d`); // 15 characters
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(Object.keys(accepted.json().windows), ["1d", "1w", "1m", "all"]);
});

test("an API-key call without user answers API_USER_REQUIRED", async () => {
  const server = app(new PortfolioSummaryStore(dataset()));
  for (const query of ["?period=1d", "?period=all&periods=1d&fresh=1"]) {
    const res = await get(server, query);
    assert.equal(res.statusCode, 400, query);
    const body = res.json();
    assertSchema(body, badSchema, "API_USER_REQUIRED", spec);
    assert.equal(body.error, "API_USER_REQUIRED");
    assert.equal(body.path, "/v1/portfolio-summary");
    assert.equal(new Date(body.timestamp).toISOString(), body.timestamp);
  }
});

test("unsupplied identities and windows answer 501, matching exactly", async () => {
  const server = app(new PortfolioSummaryStore(dataset()));
  for (const query of [
    "?user=Someone1111111111111111111111111&period=1d",
    `?user=${WALLET.toLowerCase()}&period=1d`,
    `?user=${STARKNET.toUpperCase().replace("0X", "0x")}&period=all`,
    "?user=Squad-Alpha&period=all",
    `?user=${WALLET}&period=1m`, // supplied as failed
    "?user=squad-alpha&period=1w", // never materialized
  ]) {
    const res = await get(server, query);
    assert.equal(res.statusCode, 501, query);
    assert.deepEqual(res.json(), {
      statusCode: 501,
      error: "COMPATIBILITY_NOT_IMPLEMENTED",
      reason: "PORTFOLIO_SUMMARY_UNAVAILABLE",
    }, query);
  }
});

test("the developer API-key gate still runs first", async () => {
  const res = await app(new PortfolioSummaryStore(dataset())).inject({
    method: "GET",
    url: `/v1/portfolio-summary?user=${WALLET}&period=1d`,
  });
  assert.equal(res.statusCode, 401);
});

test("without a store the documented route keeps fixture replay or 501", async () => {
  const fixture: Fixture = {
    method: "GET",
    path: "/v1/portfolio-summary",
    query: { user: WALLET, period: "1d" },
    status: 200,
    body: groupBody(1),
    source: "synthetic test fixture",
  };
  const query = `?user=${WALLET}&period=1d`;
  assert.equal((await get(app(), query)).statusCode, 501);
  const replay = await get(app(undefined, [fixture]), query);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.headers["x-reconstruction-data-source"], undefined);
  const native = await get(app(new PortfolioSummaryStore(dataset()), [fixture]), query);
  assert.equal(native.json().wallet, WALLET);
});

test("malformed datasets fail at construction", () => {
  const w = (d: any, period = "1d") => d.subjects[WALLET].periods[period];
  const g = (d: any) => d.subjects["squad-alpha"].periods.all;
  const mutations: [string, (d: any) => void][] = [
    ["extra root key", (d) => { d.extra = 1; }],
    ["missing root key", (d) => { delete d.subjects; }],
    ["version", (d) => { d.schemaVersion = 2; }],
    ["source", (d) => { d.dataSource = "live"; }],
    ["non-canonical observedAt", (d) => { d.observedAt = "2026-10-29T00:00:00Z"; }],
    // Shaped like toISOString output; Date.parse silently rolls it over to the next day.
    ["rolled-over observedAt", (d) => { d.observedAt = "2026-10-28T24:00:00.000Z"; }],
    ["impossible observedAt", (d) => { d.observedAt = "2026-02-30T00:00:00.000Z"; }],
    ["subjects array", (d) => { d.subjects = []; }],
    ["too many subjects", (d) => { d.subjects = Object.fromEntries(Array.from({ length: 10_001 }, (_, i) => [`u${i}`, { kind: "group", periods: {} }])); }],
    ["empty user key", (d) => { d.subjects[""] = d.subjects["squad-alpha"]; }],
    ["67-character user key", (d) => { d.subjects["x".repeat(67)] = d.subjects["squad-alpha"]; }],
    ["unknown kind", (d) => { d.subjects["near.account"] = { kind: "near", periods: {} }; }],
    ["extra subject key", (d) => { d.subjects["squad-alpha"].label = "x"; }],
    ["periods array", (d) => { d.subjects["squad-alpha"].periods = []; }],
    ["unknown period", (d) => { d.subjects["squad-alpha"].periods["1y"] = groupBody(1); }],
    ["array body", (d) => { d.subjects["squad-alpha"].periods.all = []; }],
    ["group body under a wallet", (d) => { d.subjects[WALLET].periods["1d"] = groupBody(1); }],
    ["wallet body under a group", (d) => { d.subjects["squad-alpha"].periods.all = walletBody(1); }],
    ["undeclared body key", (d) => { w(d).rank = 1; }],
    ["missing leg", (d) => { delete w(d).realizedPnl; }],
    ["string leg", (d) => { w(d).pnl.usd = "1"; }],
    ["from after to", (d) => { w(d).from = w(d).to + 1; }],
    ["supplied windows", (d) => { w(d).windows = {}; }],
    ["fresh cache", (d) => { w(d).cache.fresh = true; }],
    ["fresh false cache", (d) => { w(d).cache.fresh = false; }],
    ["group fresh cache", (d) => { g(d).cache.fresh = true; }],
    ["cache filled after the snapshot", (d) => { w(d).cache.filledAtMs = nowMs + 1; }],
    ["negative ttl", (d) => { w(d).cache.ttlSeconds = -1; }],
    ["computed after the snapshot", (d) => { w(d).computedAt = nowMs + 1; }],
    ["fractional token count", (d) => { w(d).tokenCount = 1.5; }],
    ["negative token count", (d) => { w(d).tokenCount = -1; }],
    ["null token count beside a PnL leg", (d) => { w(d).tokenCount = null; }],
    ...LEGS.map((kept): [string, (d: any) => void] => [`null token count beside only ${kept}`, (d) => {
      Object.assign(w(d), Object.fromEntries(LEGS.map((leg) => [leg, pair(null, null)])), { tokenCount: null });
      w(d)[kept] = pair(null, 0);
    }]),
    ["null token count and total", (d) => {
      Object.assign(w(d), Object.fromEntries(LEGS.map((leg) => [leg, pair(null, null)])), { tokenCount: null, totalValueUsd: null });
    }],
    ["mixed-case evm address", (d) => { w(d).evmAddress = `0x${"AB01".repeat(10)}`; }],
    ["short evm address", (d) => { w(d).evmAddress = "0xab01"; }],
    ["26 holdings", (d) => {
      delete w(d).reprice;
      w(d).holdings = Array.from({ length: 26 }, () => structuredClone(w(d).holdings[1]));
    }],
    ["holdings past depth", (d) => { w(d).reprice.depth = 1; }],
    ["fractional depth", (d) => { w(d).reprice.depth = 2.5; }],
    ["mark source without mark", (d) => { w(d).holdings[0].markUsd = null; }],
    ["mark without mark source", (d) => { w(d).holdings[1].markUsd = 1; }],
    ["absent mark beside a source", (d) => { delete w(d).holdings[0].markUsd; }],
    ["reprice without holdings", (d) => { delete w(d).holdings; }],
    ["reprice beside null holdings", (d) => { w(d).holdings = null; }],
    ["null reprice beside holdings", (d) => { w(d).reprice = null; }],
    ["repriced after the snapshot", (d) => { w(d).reprice.asOf = nowMs + 1; }],
    ["51 unrepriced rows", (d) => { w(d).reprice.unrepriced = Array.from({ length: 51 }, () => structuredClone(w(d).reprice.unrepriced[0])); }],
    ["ran with a reason", (d) => { w(d).reprice.reason = "timeout"; }],
    ["did not run without a reason", (d) => { w(d).reprice.plane = "none"; }],
    ["null bucket without a reason", (d) => { w(d).identity.subCentUsd = null; }],
    ["null bucket with a blank reason", (d) => { w(d).identity.reasons.perpsUsd = " "; }],
    ["null tail without a reason", (d) => { delete w(d).identity.reasons.tailValueUsd; }],
    ["windows disagree on the wallet", (d) => { w(d, "1w").wallet = "Other11111111111111111111111111111"; }],
    ["windows disagree on the group", (d) => { d.subjects["squad-alpha"].periods["1d"].groupId = "group-2"; }],
    ["Starknet all with realized PnL", (d) => { d.subjects[STARKNET].periods.all.realizedPnl = pair(0, null); }],
    ["Starknet all with PnL", (d) => { d.subjects[STARKNET].periods.all.pnl = pair(null, 0); }],
    ["upper-case Starknet all with PnL", (d) => {
      const upper = `0x${"AB".repeat(32)}`;
      d.subjects[upper] = { kind: "wallet", periods: { all: { ...starknetBody(), wallet: upper, pnl: pair(1, 1) } } };
    }],
    ["fractional member count", (d) => { g(d).memberCount = 1.5; }],
    ["negative members included", (d) => { g(d).membersIncluded = -1; }],
    ["group with a wallet key", (d) => { g(d).wallet = WALLET; }],
  ];
  assert.doesNotThrow(() => new PortfolioSummaryStore(dataset()));
  for (const [label, mutate] of mutations) {
    const d = structuredClone(dataset()) as any;
    mutate(d);
    assert.throws(() => new PortfolioSummaryStore(d), TypeError, label);
  }
});

test("declared variants the contract allows are accepted", () => {
  const variants: [string, (d: any) => void][] = [
    ["balance leg alone", (d) => {
      Object.assign(d.subjects[WALLET].periods["1d"], Object.fromEntries(LEGS.map((leg) => [leg, pair(null, null)])), { tokenCount: null });
    }],
    ["no linked EVM wallet", (d) => { d.subjects[WALLET].periods["1d"].evmAddress = null; }],
    ["EVM lookup failed", (d) => { delete d.subjects[WALLET].periods["1d"].evmAddress; }],
    ["no reprice ran", (d) => { Object.assign(d.subjects[WALLET].periods["1d"].reprice, { plane: "none", reason: "breaker_open" }); }],
    ["filled outside the reprice", (d) => { delete d.subjects[WALLET].periods["1d"].reprice; }],
    ["null holdings and reprice", (d) => { Object.assign(d.subjects[WALLET].periods["1d"], { holdings: null, reprice: null }); }],
    ["null identity", (d) => { d.subjects[WALLET].periods["1d"].identity = null; }],
    ["window starting at its end", (d) => { d.subjects[WALLET].periods["1d"].from = d.subjects[WALLET].periods["1d"].to; }],
    ["Starknet non-all PnL", (d) => {
      d.subjects[STARKNET].periods["1d"] = { ...starknetBody(), pnl: pair(1, 2), realizedPnl: pair(1, 2) };
    }],
    ["a failed window only", (d) => { d.subjects.solo = { kind: "group", periods: { "1d": null } }; }],
    ["empty subjects", (d) => { d.subjects = {}; }],
  ];
  for (const [label, mutate] of variants) {
    const d = structuredClone(dataset()) as any;
    mutate(d);
    assert.doesNotThrow(() => new PortfolioSummaryStore(d), label);
  }
});

test("the store owns its data against input and response mutation", async () => {
  const d = dataset();
  const store = new PortfolioSummaryStore(d);
  (d.subjects[WALLET].periods["1d"] as any).pnl.usd = -1;
  delete d.subjects["squad-alpha"];
  const first = store.summary({ user: WALLET, period: "1d", periods: ["1d"], holdings: true }) as any;
  first.pnl.usd = 99;
  first.holdings.pop();
  first.windows["1d"].from = 0;
  const again = store.summary({ user: WALLET, period: "1d", periods: ["1d"], holdings: true }) as any;
  assert.deepEqual({ ...again, windows: undefined }, { ...walletBody(1), windows: undefined });
  assert.deepEqual(again.windows["1d"], legs(1));
  assert.ok(store.summary({ user: "squad-alpha", period: "all", holdings: false }));
});

test("the startup loader reads only a bounded regular file", () => {
  const dir = mkdtempSync(join(tmpdir(), "portfolio-summary-"));
  try {
    const file = join(dir, "summary.json");
    writeFileSync(file, JSON.stringify(dataset()));
    assert.equal(loadPortfolioSummaryStore(undefined), undefined);
    assert.equal(loadPortfolioSummaryStore(file)!.summary({ user: WALLET, period: "1d", holdings: false }).wallet, WALLET);
    const link = join(dir, "link.json");
    symlinkSync(file, link);
    assert.throws(() => loadPortfolioSummaryStore(link));
    // Where O_NOFOLLOW is unavailable (Windows), the symlink is still refused.
    assert.throws(() => loadPortfolioSummaryStore(link, 0), /file type/);
    assert.throws(() => loadPortfolioSummaryStore(dir, 0), /file type/);
    assert.ok(loadPortfolioSummaryStore(file, 0));
    writeFileSync(file, Buffer.from([0x7b, 0xff, 0x7d]));
    assert.throws(() => loadPortfolioSummaryStore(file), TypeError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
