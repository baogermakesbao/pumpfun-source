import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildApp, type Fixture } from "../src/app.js";
import {
  AmbiguousMintChainError,
  TopTraderTradesStore,
  loadTopTraderTradesStore,
  type TopTraderFact,
  type TopTraderTrade,
  type TopTraderTradesDataset,
} from "../src/top-trader-trades-store.js";
import { assertSchema } from "../src/schema-validator.js";

const now = "2026-10-29T00:00:00.000Z";
const nowMs = Date.parse(now);
// Synthetic shape-only credential for in-process compatibility-gate tests.
const headers = { authorization: `Bearer pf_live_${"a".repeat(49)}` };
const base = "/v1/pnl-leaderboard/top-trader-trades";
const spec = JSON.parse(
  readFileSync(new URL("../../../contracts/developer.openapi.json", import.meta.url), "utf8"),
);
const okSchema =
  spec.paths["/pnl-leaderboard/top-trader-trades/{mint}"].get.responses["200"].content[
    "application/json"
  ].schema;

const slot = (n: number) => String(n).padStart(26, "0");
function trader(userId: string, bestRank: number, periods: TopTraderFact["periods"] = ["daily"]): TopTraderFact {
  return {
    userId,
    walletAddress: `${userId}-board`,
    username: userId,
    profileImage: null,
    isVerified: false,
    verifiedBadgeVisible: false,
    bestRank,
    periods,
  };
}
function trade(n: number, userId: string, mint = "MintA", wallet = `${userId}-board`): TopTraderTrade {
  return {
    tx: `tx-${n}`,
    isBuy: n % 2 === 0,
    timestamp: new Date(nowMs - (100 - n) * 1000).toISOString(),
    amountUsd: n,
    baseAmount: null,
    priceUsd: 0.5,
    mint,
    chainId: 0,
    walletAddress: wallet,
    userId,
    slotIndexId: slot(n),
    amountSol: null,
  };
}
function dataset(): TopTraderTradesDataset {
  return {
    schemaVersion: 1,
    dataSource: "synthetic",
    observedAt: now,
    boardsBuiltAtMs: nowMs - 60_000,
    generatedAtMs: nowMs - 1_000,
    traders: [trader("t-late", 7, ["daily", "monthly"]), trader("t-best", 1), trader("t-quiet", 2)],
    trades: [
      trade(10, "t-best"),
      trade(30, "t-late", "MintA", "t-late-alt"),
      trade(20, "t-late"),
      trade(40, "t-best", "MintA", "t-best-alt"),
      trade(50, "t-quiet", "MintB"),
    ],
  };
}
const app = (store?: TopTraderTradesStore, fixtures: Fixture[] = []) =>
  buildApp(fixtures, store ? { topTraderTradesStore: store } : {});
const get = (a: ReturnType<typeof app>, rest: string) => a.inject({ method: "GET", url: `${base}/${rest}`, headers });

test("the declared contract text is the pinned captured range", () => {
  // Read and hash only; captured code is never imported or executed.
  const source = readFileSync(
    new URL("../../../evidence/web/objects/2b47dd0b38a1608f.js", import.meta.url),
    "utf8",
  );
  const route = source.slice(312224, 314130);
  const rows = source.slice(303352, 305280);
  assert.equal(createHash("sha256").update(route).digest("hex"), "c1b45e8a93e62ad290d36cbf204942c491fa02c9b4753879bf24d4e237d56c22");
  assert.equal(createHash("sha256").update(rows).digest("hex"), "5123e8043098d65c3303cfee4c281910d6cc411ddf1d293d74cb91c1b7f5f6b6");
  for (const phrase of [
    "Only top traders with at least one served trade on the coin, best rank first",
    "newest first; the newest `limit` (default 500) across all of them",
    "Trades per page; default and ceiling 500",
    "Null means the response is the whole set",
    "null = nothing older",
  ])
    assert.ok(route.includes(phrase), phrase);
  assert.ok(rows.includes("26-digit zero-padded chain-ordered id"));
  assert.ok(rows.includes("The distinct walletAddress values of this trader's served rows, sorted"));
});

test("the whole set serves newest first, traders best rank first, page null", async () => {
  const res = await get(app(new TopTraderTradesStore(dataset())), "MintA");
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assertSchema(body, okSchema, "top-trader trades", spec);
  assert.equal(body.mint, "MintA");
  assert.deepEqual(body.trades.map((t: TopTraderTrade) => t.tx), ["tx-40", "tx-30", "tx-20", "tx-10"]);
  assert.deepEqual(body.traders.map((t: any) => [t.userId, t.bestRank, t.tradeCount]), [["t-best", 1, 2], ["t-late", 7, 2]]);
  assert.deepEqual(body.traders[0].tradingWallets, ["t-best-alt", "t-best-board"]);
  assert.deepEqual(body.traders[1].periods, ["daily", "monthly"]);
  assert.equal(body.page, null);
  assert.equal(body.boardsBuiltAtMs, nowMs - 60_000);
  assert.equal(body.generatedAtMs, nowMs - 1_000);
  assert.equal(res.headers["x-reconstruction-data-source"], "synthetic");
  assert.equal(res.headers["x-reconstruction-observed-at"], now);
  assert.equal(res.headers["x-reconstruction-compatibility"], "unqualified");
});

test("tradingWallets are the distinct served wallets, sorted rather than in trade order", () => {
  const d = dataset();
  d.trades.push(trade(45, "t-best", "MintA", "z-wallet"), trade(5, "t-best", "MintA", "a-wallet"));
  d.trades.push(trade(44, "t-best", "MintA", "z-wallet"));
  const [best] = new TopTraderTradesStore(d).trades("MintA").traders;
  assert.deepEqual(best.tradingWallets, ["a-wallet", "t-best-alt", "t-best-board", "z-wallet"]);
  assert.equal(best.tradeCount, 5);
});

test("a coin without top-trader trades is an empty whole set", async () => {
  const body = (await get(app(new TopTraderTradesStore(dataset())), "UnknownMint")).json();
  assert.deepEqual(body.traders, []);
  assert.deepEqual(body.trades, []);
  assert.equal(body.page, null);
  assert.equal(body.mint, "UnknownMint");
});

test("limit pages with an opaque cursor until nothing is older", async () => {
  const a = app(new TopTraderTradesStore(dataset()));
  const first = (await get(a, "MintA?limit=3")).json();
  assert.deepEqual(first.trades.map((t: any) => t.tx), ["tx-40", "tx-30", "tx-20"]);
  assert.deepEqual(first.page, { nextCursor: `s:${slot(20)}`, to: null, limit: 3 });
  // Traders reflect only the served trades.
  assert.deepEqual(first.traders.map((t: any) => [t.userId, t.tradeCount, t.tradingWallets]), [
    ["t-best", 1, ["t-best-alt"]],
    ["t-late", 2, ["t-late-alt", "t-late-board"]],
  ]);
  const second = (await get(a, `MintA?limit=3&cursor=${first.page.nextCursor}`)).json();
  assert.deepEqual(second.trades.map((t: any) => t.tx), ["tx-10"]);
  assert.deepEqual(second.page, { nextCursor: null, to: null, limit: 3 });
  const exact = (await get(a, "MintA?limit=4")).json();
  assert.equal(exact.page.nextCursor, null);
});

test("more than 500 trades is never served as a null-page whole set", () => {
  const d = dataset();
  d.trades = Array.from({ length: 501 }, (_, i) => trade(i + 1, "t-best"));
  d.trades.forEach((t, i) => { t.timestamp = new Date(nowMs - (501 - i) * 1000).toISOString(); });
  const page = new TopTraderTradesStore(d).trades("MintA");
  assert.equal(page.trades.length, 500);
  assert.deepEqual(page.page, { nextCursor: `s:${slot(2)}`, to: null, limit: 500 });
  assert.equal(page.traders[0].tradeCount, 500);
});

test("to serves trades at or before the instant and echoes it", async () => {
  const a = app(new TopTraderTradesStore(dataset()));
  const at = nowMs - 70 * 1000; // trade 30's instant
  const body = (await get(a, `MintA?to=${at}`)).json();
  assert.deepEqual(body.trades.map((t: any) => t.tx), ["tx-30", "tx-20", "tx-10"]);
  assert.deepEqual(body.page, { nextCursor: null, to: at, limit: 500 });
  const d = dataset();
  d.trades[0].timestamp = null;
  const undated = new TopTraderTradesStore(d);
  assert.deepEqual(undated.trades("MintA", { to: nowMs }).trades.map((t) => t.tx), ["tx-40", "tx-30", "tx-20"]);
  assert.equal(undated.trades("MintA").trades.length, 4);
});

test("chainId filters, and an omitted chainId never guesses across chains", async () => {
  const d = dataset();
  d.trades[0].chainId = 8453;
  const a = app(new TopTraderTradesStore(d));
  const evm = (await get(a, "MintA?chainId=8453")).json();
  assert.deepEqual(evm.trades.map((t: any) => t.tx), ["tx-10"]);
  const none = (await get(a, "MintA?chainId=-1")).json();
  assert.deepEqual(none.trades, []);
  const res = await get(a, "MintA");
  assert.equal(res.statusCode, 501);
  assert.equal(res.json().reason, "MINT_CHAIN_INFERENCE_UNAVAILABLE");
  assert.throws(() => new TopTraderTradesStore(d).trades("MintA"), AmbiguousMintChainError);
});

test("strict queries reject unknown, repeated and malformed values", async () => {
  const a = app(new TopTraderTradesStore(dataset()));
  for (const query of [
    "limit=0", "limit=501", "limit=1.5", "limit=", "limit=01", "to=-1", "to=1e3",
    "chainId=1.0", "chainId=-0", "cursor=abc", `cursor=s:${slot(1)}x`, `cursor=${"s".repeat(201)}`,
    "limit=1&limit=2", "page=1", `to=${Number.MAX_SAFE_INTEGER + 2}`,
  ]) {
    const res = await get(a, `MintA?${query}`);
    assert.equal(res.statusCode, 400, query);
    assert.deepEqual(res.json(), { statusCode: 400, error: "INVALID_QUERY" });
  }
});

test("the developer API-key gate still runs first", async () => {
  const res = await app(new TopTraderTradesStore(dataset())).inject({ method: "GET", url: `${base}/MintA` });
  assert.equal(res.statusCode, 401);
});

test("without a store the documented route keeps fixture replay or 501", async () => {
  const fixture: Fixture = {
    method: "GET",
    path: `${base}/MintA`,
    status: 200,
    body: { mint: "MintA", traders: [], trades: [], boardsBuiltAtMs: 0, generatedAtMs: 0, page: null },
    source: "synthetic test fixture",
  };
  assert.equal((await get(app(), "MintA")).statusCode, 501);
  const replay = await get(app(undefined, [fixture]), "MintA");
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.headers["x-reconstruction-data-source"], undefined);
  const native = await get(app(new TopTraderTradesStore(dataset()), [fixture]), "MintA");
  assert.equal(native.json().trades.length, 4);
});

test("malformed datasets fail at construction", () => {
  const cases: [string, (d: any) => void][] = [
    ["trade without trader", (d) => { d.trades[0].userId = "stranger"; }],
    ["duplicate trader", (d) => { d.traders.push(trader("t-best", 3)); }],
    ["duplicate slot", (d) => {
      // Same instant too, so only the identity check can reject it.
      d.trades[1].slotIndexId = slot(10);
      d.trades[1].timestamp = d.trades[0].timestamp;
    }],
    ["short slot", (d) => { d.trades[0].slotIndexId = "10"; }],
    ["rank outside top 50", (d) => { d.traders[0].bestRank = 51; }],
    ["rank zero", (d) => { d.traders[0].bestRank = 0; }],
    ["no periods", (d) => { d.traders[0].periods = []; }],
    ["periods out of order", (d) => { d.traders[0].periods = ["monthly", "daily"]; }],
    ["repeated period", (d) => { d.traders[0].periods = ["daily", "daily"]; }],
    ["unknown period", (d) => { d.traders[0].periods = ["hourly"]; }],
    ["future trade", (d) => { d.trades[0].timestamp = "2026-10-29T00:00:00.001Z"; }],
    ["timestamps against chain order", (d) => { d.trades[0].timestamp = new Date(nowMs - 5_000).toISOString(); }],
    ["non-finite amount", (d) => { d.trades[0].amountUsd = Number.NaN; }],
    ["fractional chain", (d) => { d.trades[0].chainId = 1.5; }],
    ["extra trade key", (d) => { d.trades[0].side = "buy"; }],
    ["extra trader key", (d) => { d.traders[0].tradingWallets = []; }],
    ["future boards", (d) => { d.boardsBuiltAtMs = nowMs + 1; }],
    ["generated before boards", (d) => { d.generatedAtMs = d.boardsBuiltAtMs - 1; }],
    ["bad observedAt", (d) => { d.observedAt = "yesterday"; }],
    ["bad source", (d) => { d.dataSource = "upstream"; }],
  ];
  for (const [label, mutate] of cases) {
    const d = dataset();
    mutate(d);
    assert.throws(() => new TopTraderTradesStore(d), TypeError, label);
  }
});

test("the store owns its data against input and response mutation", () => {
  const d = dataset();
  const store = new TopTraderTradesStore(d);
  d.trades[0].tx = "mutated";
  d.traders[1].periods.push("weekly");
  const first = store.trades("MintA");
  first.trades[3].tx = "mutated";
  first.traders[0].periods.push("weekly");
  first.traders[0].tradingWallets.push("mutated");
  const again = store.trades("MintA");
  assert.equal(again.trades[3].tx, "tx-10");
  assert.deepEqual(again.traders[0].periods, ["daily"]);
  assert.deepEqual(again.traders[0].tradingWallets, ["t-best-alt", "t-best-board"]);
});

test("the startup loader reads only a bounded regular file", () => {
  const dir = mkdtempSync(join(tmpdir(), "top-trader-trades-"));
  try {
    const file = join(dir, "trades.json");
    writeFileSync(file, JSON.stringify(dataset()));
    assert.equal(loadTopTraderTradesStore(undefined), undefined);
    assert.equal(loadTopTraderTradesStore(file)!.trades("MintA").trades.length, 4);
    const link = join(dir, "link.json");
    symlinkSync(file, link);
    assert.throws(() => loadTopTraderTradesStore(link));
    writeFileSync(file, Buffer.from([0x7b, 0xff, 0x7d]));
    assert.throws(() => loadTopTraderTradesStore(file), TypeError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
