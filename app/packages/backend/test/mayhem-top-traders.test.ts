import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildApp, type Fixture } from "../src/app.js";
import {
  MayhemTopTradersStore,
  loadMayhemTopTradersStore,
  type MayhemTopTradersDataset,
  type MayhemTrader,
} from "../src/mayhem-top-traders-store.js";
import { assertSchema } from "../src/schema-validator.js";

const now = "2026-10-29T00:00:00.000Z";
const nowMs = Date.parse(now);
const snapshotMs = nowMs - 60_000;
// Synthetic shape-only credential for in-process compatibility-gate tests.
const headers = { authorization: `Bearer pf_live_${"a".repeat(49)}` };
const spec = JSON.parse(
  readFileSync(new URL("../../../contracts/developer.openapi.json", import.meta.url), "utf8"),
);
const okSchema =
  spec.paths["/mayhem/{mint}/top-traders"].get.responses["200"].content["application/json"].schema;

function trader(rank: number, address: string): MayhemTrader {
  return {
    rank,
    address,
    username: rank === 1 ? "whale" : null,
    profileImage: null,
    realisedPnlUsd: 1000 / rank - 100,
    averageEntryMarketCapUsd: 25_000,
    averageExitMarketCapUsd: 80_000,
    totalBoughtUsd: 300,
    totalSoldUsd: 900,
    buyTransactionCount: 3,
    sellTransactionCount: 2,
    tokenBalance: "18446744073709551615",
    tokenAmountBought: 1_000_000,
    tokenAmountSold: 400_000,
    lastActivityAt: Math.floor(snapshotMs / 1000) - rank,
  };
}
function dataset(): MayhemTopTradersDataset {
  return {
    schemaVersion: 1,
    dataSource: "synthetic",
    observedAt: now,
    boards: {
      MayhemMint: { updatedAt: snapshotMs, traders: [trader(1, "addr-a"), trader(2, "addr-b"), trader(2, "addr-c"), trader(4, "addr-d")] },
      Quiet: { updatedAt: snapshotMs, traders: [] },
    },
  };
}
function app(store?: MayhemTopTradersStore, fixtures: Fixture[] = []) {
  return buildApp(fixtures, store ? { mayhemTopTradersStore: store } : {});
}
function get(server: ReturnType<typeof buildApp>, mint: string, query = "") {
  return server.inject({ method: "GET", url: `/v1/mayhem/${mint}/top-traders${query}`, headers });
}

test("the declared contract text is the pinned captured range", () => {
  // Read and hash only; captured code is never imported or executed.
  const source = readFileSync(
    new URL("../../../evidence/web/objects/2b47dd0b38a1608f.js", import.meta.url),
    "utf8",
  );
  const route = source.slice(266655, 267511);
  assert.equal(createHash("sha256").update(route).digest("hex"), "7461ebef83e314c8038db91da214c813ea1f00632755131064fd50af94068c28");
  for (const phrase of [
    '(0,s.publicRead)("leaderboards.read"',
    "params:u,response:",
    "Epoch ms when this snapshot was taken",
    "Raw token amount as a string (may exceed Number.MAX_SAFE_INTEGER)",
    'lastActivityAt:o.z.number().describe("Epoch seconds")',
  ])
    assert.ok(route.includes(phrase), phrase);
  // No query object and no declared 404 on this operation.
  assert.ok(!route.includes("query:"));
  assert.ok(!route.includes("404"));
});

test("a supplied snapshot is served in the producer's rank order", async () => {
  const res = await get(app(new MayhemTopTradersStore(dataset())), "MayhemMint");
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-reconstruction-data-source"], "synthetic");
  assert.equal(res.headers["x-reconstruction-observed-at"], now);
  assert.equal(res.headers["x-reconstruction-compatibility"], "unqualified");
  const body = res.json();
  assertSchema(body, okSchema, "board", spec);
  assert.equal(body.mint, "MayhemMint");
  assert.equal(body.updatedAt, snapshotMs);
  assert.deepEqual(body.traders.map((row: any) => [row.rank, row.address]), [
    [1, "addr-a"],
    [2, "addr-b"],
    [2, "addr-c"],
    [4, "addr-d"],
  ]);
  assert.equal(body.traders[0].username, "whale");
  // A raw u64 balance survives as an exact string.
  assert.equal(body.traders[0].tokenBalance, "18446744073709551615");
});

test("a supplied empty board is an empty 200; an unsupplied coin is a 501", async () => {
  const server = app(new MayhemTopTradersStore(dataset()));
  const quiet = await get(server, "Quiet");
  assert.equal(quiet.statusCode, 200);
  assertSchema(quiet.json(), okSchema, "quiet", spec);
  assert.deepEqual(quiet.json(), { mint: "Quiet", updatedAt: snapshotMs, traders: [] });
  const unknown = await get(server, "NeverMayhem");
  assert.equal(unknown.statusCode, 501);
  assert.deepEqual(unknown.json(), {
    statusCode: 501,
    error: "COMPATIBILITY_NOT_IMPLEMENTED",
    reason: "MAYHEM_BOARD_UNAVAILABLE",
  });
});

test("the mint is matched exactly, never case-folded", async () => {
  const res = await get(app(new MayhemTopTradersStore(dataset())), "mayhemmint");
  assert.equal(res.statusCode, 501);
});

test("the operation declares no query parameters", async () => {
  const server = app(new MayhemTopTradersStore(dataset()));
  for (const query of ["?limit=10", "?window=24h", "?mint=MayhemMint", "?", "?=", "?a"]) {
    const res = await get(server, "MayhemMint", query);
    const expected = query === "?" ? 200 : 400;
    assert.equal(res.statusCode, expected, query);
    if (expected === 400) assert.deepEqual(res.json(), { statusCode: 400, error: "INVALID_QUERY" }, query);
  }
});

test("the developer API-key gate still runs first", async () => {
  const res = await app(new MayhemTopTradersStore(dataset())).inject({ method: "GET", url: "/v1/mayhem/MayhemMint/top-traders" });
  assert.equal(res.statusCode, 401);
});

test("without a store the documented route keeps fixture replay or 501", async () => {
  const fixture: Fixture = {
    method: "GET",
    path: "/v1/mayhem/MayhemMint/top-traders",
    status: 200,
    body: { mint: "MayhemMint", updatedAt: 0, traders: [] },
    source: "synthetic test fixture",
  };
  assert.equal((await get(app(), "MayhemMint")).statusCode, 501);
  const replay = await get(app(undefined, [fixture]), "MayhemMint");
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.headers["x-reconstruction-data-source"], undefined);
  const native = await get(app(new MayhemTopTradersStore(dataset()), [fixture]), "MayhemMint");
  assert.equal(native.json().traders.length, 4);
});

test("malformed datasets fail at construction", () => {
  const first = (d: any) => d.boards.MayhemMint.traders[0];
  const mutations: [string, (d: any) => void][] = [
    ["extra root key", (d) => { d.extra = 1; }],
    ["version", (d) => { d.schemaVersion = 2; }],
    ["source", (d) => { d.dataSource = "live"; }],
    ["non-canonical observedAt", (d) => { d.observedAt = "2026-10-29T00:00:00Z"; }],
    ["boards array", (d) => { d.boards = []; }],
    ["extra board key", (d) => { d.boards.MayhemMint.extra = 1; }],
    ["future snapshot", (d) => { d.boards.MayhemMint.updatedAt = nowMs + 1; }],
    ["fractional snapshot", (d) => { d.boards.MayhemMint.updatedAt = snapshotMs + 0.5; }],
    ["extra trader key", (d) => { first(d).winRate = 0.5; }],
    ["missing trader key", (d) => { delete first(d).tokenBalance; }],
    ["zero rank", (d) => { first(d).rank = 0; }],
    ["fractional rank", (d) => { first(d).rank = 1.5; }],
    ["rank goes backwards", (d) => { d.boards.MayhemMint.traders[3].rank = 1; }],
    ["duplicate address", (d) => { d.boards.MayhemMint.traders[1].address = "addr-a"; }],
    ["empty address", (d) => { first(d).address = ""; }],
    ["NaN pnl", (d) => { first(d).realisedPnlUsd = Number.NaN; }],
    ["negative bought", (d) => { first(d).totalBoughtUsd = -1; }],
    ["negative sold amount", (d) => { first(d).tokenAmountSold = -1; }],
    ["negative entry mcap", (d) => { first(d).averageEntryMarketCapUsd = -1; }],
    ["fractional tx count", (d) => { first(d).buyTransactionCount = 1.5; }],
    ["numeric balance", (d) => { first(d).tokenBalance = 5; }],
    ["negative balance", (d) => { first(d).tokenBalance = "-5"; }],
    ["padded balance", (d) => { first(d).tokenBalance = "05"; }],
    ["decimal balance", (d) => { first(d).tokenBalance = "5.0"; }],
    ["balance over uint256", (d) => { first(d).tokenBalance = (2n ** 256n).toString(); }],
    ["activity after snapshot", (d) => { first(d).lastActivityAt = Math.floor(snapshotMs / 1000) + 1; }],
    ["activity in ms", (d) => { first(d).lastActivityAt = snapshotMs; }],
    ...(["buy", "sell"] as const).flatMap((side) => {
      const fields = side === "buy"
        ? { count: "buyTransactionCount", usd: "totalBoughtUsd", amount: "tokenAmountBought", average: "averageEntryMarketCapUsd" }
        : { count: "sellTransactionCount", usd: "totalSoldUsd", amount: "tokenAmountSold", average: "averageExitMarketCapUsd" };
      // Each case leaves exactly one field inconsistent with a zero-transaction side.
      const empty = (d: any) => Object.assign(first(d), { [fields.count]: 0, [fields.usd]: 0, [fields.amount]: 0, [fields.average]: null });
      return [
        [`${side}: usd without transactions`, (d: any) => { empty(d); first(d)[fields.usd] = 1; }],
        [`${side}: amount without transactions`, (d: any) => { empty(d); first(d)[fields.amount] = 1; }],
        [`${side}: average without transactions`, (d: any) => { empty(d); first(d)[fields.average] = 1; }],
      ] as [string, (d: any) => void][];
    }),
    ["hole in traders", (d) => { d.boards.MayhemMint.traders = [first(d), , trader(3, "x")]; }],
  ];
  assert.doesNotThrow(() => new MayhemTopTradersStore(dataset()));
  for (const [label, mutate] of mutations) {
    const d = structuredClone(dataset()) as any;
    mutate(d);
    assert.throws(() => new MayhemTopTradersStore(d), TypeError, label);
  }
});

test("a side with no transactions is accepted when it carries nothing", () => {
  const d = dataset();
  Object.assign(d.boards.MayhemMint.traders[3], {
    sellTransactionCount: 0,
    totalSoldUsd: 0,
    tokenAmountSold: 0,
    averageExitMarketCapUsd: null,
  });
  Object.assign(d.boards.MayhemMint.traders[2], {
    buyTransactionCount: 0,
    totalBoughtUsd: 0,
    tokenAmountBought: 0,
    averageEntryMarketCapUsd: null,
  });
  const board = new MayhemTopTradersStore(d).board("MayhemMint");
  assert.equal(board.traders[3].averageExitMarketCapUsd, null);
  assert.equal(board.traders[2].averageEntryMarketCapUsd, null);
});

test("supplied text is served verbatim", async () => {
  const d = dataset();
  d.boards.MayhemMint.traders[0].address = " Spaced Addr ";
  d.boards.MayhemMint.traders[0].username = "Ünïcode name";
  const body = (await get(app(new MayhemTopTradersStore(d)), "MayhemMint")).json();
  assert.equal(body.traders[0].address, " Spaced Addr ");
  assert.equal(body.traders[0].username, "Ünïcode name");
});

test("the store owns its data against input and response mutation", () => {
  const d = dataset();
  const store = new MayhemTopTradersStore(d);
  d.boards.MayhemMint.traders[0].address = "changed";
  d.boards.MayhemMint.traders.reverse();
  const first = store.board("MayhemMint");
  first.traders[0].address = "mutated";
  first.traders.pop();
  const second = store.board("MayhemMint");
  assert.equal(second.traders[0].address, "addr-a");
  assert.equal(second.traders.length, 4);
});

test("the startup loader reads only a bounded regular file", () => {
  const dir = mkdtempSync(join(tmpdir(), "mayhem-top-traders-"));
  try {
    const file = join(dir, "mayhem.json");
    writeFileSync(file, JSON.stringify(dataset()));
    assert.equal(loadMayhemTopTradersStore(undefined), undefined);
    assert.equal(loadMayhemTopTradersStore(file)!.board("MayhemMint").traders.length, 4);
    const link = join(dir, "link.json");
    symlinkSync(file, link);
    assert.throws(() => loadMayhemTopTradersStore(link));
    // Where O_NOFOLLOW is unavailable (Windows), the symlink is still refused.
    assert.throws(() => loadMayhemTopTradersStore(link, 0), /file type/);
    assert.throws(() => loadMayhemTopTradersStore(dir, 0), /file type/);
    assert.ok(loadMayhemTopTradersStore(file, 0));
    writeFileSync(file, Buffer.from([0x7b, 0xff, 0x7d]));
    assert.throws(() => loadMayhemTopTradersStore(file), TypeError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
