import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildApp, type Fixture } from "../src/app.js";
import {
  GroupBoardStore,
  loadGroupBoardStore,
  UnavailableGroupBoardError,
  type GroupBoardDataset,
  type GroupBoardFact,
} from "../src/group-board-store.js";
import { assertSchema } from "../src/schema-validator.js";

const now = "2026-10-29T00:00:00.000Z";
const nowMs = Date.parse(now);
// Synthetic shape-only credential for in-process compatibility-gate tests.
const headers = { authorization: `Bearer pf_live_${"a".repeat(49)}` };
const path = "/v1/pnl-leaderboard/groups";
const spec = JSON.parse(
  readFileSync(new URL("../../../contracts/developer.openapi.json", import.meta.url), "utf8"),
);
const okSchema =
  spec.paths["/pnl-leaderboard/groups"].get.responses["200"].content["application/json"].schema;

function row(groupId: string, pnlUsd: number, realizedPnlUsd: number, positions = 0): GroupBoardFact {
  return {
    groupId,
    memberCount: 5,
    membersCounted: 4,
    username: `${groupId}-squad`,
    profileImageUrl: null,
    isVerified: false,
    verifiedBadgeVisible: false,
    pnlSol: pnlUsd / 200,
    pnlUsd,
    pnlPercent: 1.5,
    buySpendSol: 10,
    lastRefreshedAtMs: nowMs - 1_000,
    realizedPnlSol: realizedPnlUsd / 200,
    realizedPnlUsd,
    unrealizedPnlSol: (pnlUsd - realizedPnlUsd) / 200,
    unrealizedPnlUsd: pnlUsd - realizedPnlUsd,
    positions: Array.from({ length: positions }, (_, index) => ({
      mint: `mint-${index}`,
      chainId: 0,
      symbol: null,
      name: null,
      imageUri: null,
      valueUsd: index,
    })),
  };
}
function dataset(): GroupBoardDataset {
  return {
    schemaVersion: 1,
    dataSource: "synthetic",
    observedAt: now,
    boards: {
      daily: {
        periodLabel: "Synthetic daily",
        windowStartSec: nowMs / 1000 - 86_400,
        rows: [row("g-b", 100, 10, 7), row("g-a", 100, 90), row("g-c", 300, -50, 2)],
      },
    },
  };
}
const app = (store?: GroupBoardStore, fixtures: Fixture[] = []) =>
  buildApp(fixtures, store ? { groupBoardStore: store } : {});
const get = (a: ReturnType<typeof app>, query: string) =>
  a.inject({ method: "GET", url: `${path}?${query}`, headers });

test("the declared group board contract text is the pinned captured range", () => {
  // Read and hash only; captured code is never imported or executed.
  const source = readFileSync(
    new URL("../../../evidence/web/objects/2b47dd0b38a1608f.js", import.meta.url),
    "utf8",
  );
  const declared = source.slice(303179, 310781);
  assert.equal(
    createHash("sha256").update(declared).digest("hex"),
    "75906f46d487bd0c82183d8ce2b053ad70de4c71c40ece8f5d244f47bbe4670d",
  );
  for (const phrase of [
    "0 unspecified, 1 weekly, 2 monthly, 3 daily",
    "Rows served (default and ceiling 100; out-of-range values clamp).",
    "default 3; values above 5 clamp to 5; 0 = count only",
    "Largest fresh USD value first, sliced to positionsLimit",
    "never sliced by positionsLimit",
  ])
    assert.ok(declared.includes(phrase), phrase);
});

test("the board ranks by combined PnL by default, schema-checked with provenance headers", async () => {
  const res = await get(app(new GroupBoardStore(dataset())), "period=daily");
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assertSchema(body, okSchema, "group board", spec);
  assert.deepEqual(body.entries.map((e: any) => [e.rank, e.groupId]), [[1, "g-c"], [2, "g-a"], [3, "g-b"]]);
  assert.equal(body.periodType, 3);
  assert.equal(body.periodLabel, "Synthetic daily");
  assert.equal(body.windowStartSec, nowMs / 1000 - 86_400);
  assert.equal(body.totalRanked, 3);
  assert.equal(res.headers["x-reconstruction-data-source"], "synthetic");
  assert.equal(res.headers["x-reconstruction-observed-at"], now);
  assert.equal(res.headers["x-reconstruction-compatibility"], "unqualified");
});

test("sort selects the realized or unrealized measure and re-ranks", async () => {
  const a = app(new GroupBoardStore(dataset()));
  const ids = async (query: string) => (await get(a, query)).json().entries.map((e: any) => e.groupId);
  assert.deepEqual(await ids("period=daily&sort=realized"), ["g-a", "g-b", "g-c"]);
  assert.deepEqual(await ids("period=daily&sort=unrealized"), ["g-c", "g-b", "g-a"]);
  assert.deepEqual(await ids("period=daily&sort=combined"), ["g-c", "g-a", "g-b"]);
  const realized = (await get(a, "period=daily&sort=realized")).json().entries;
  assert.deepEqual(realized.map((e: any) => e.rank), [1, 2, 3]);
});

test("limit defaults to and clamps at 100, and clamps negatives to an empty page", async () => {
  const big = dataset();
  big.boards.daily!.rows = Array.from({ length: 120 }, (_, i) => row(`g-${String(i).padStart(3, "0")}`, i, 0));
  const a = app(new GroupBoardStore(big));
  for (const [query, expected] of [["", 100], ["&limit=1000", 100], ["&limit=2", 2], ["&limit=0", 0], ["&limit=-5", 0]] as const) {
    const body = (await get(a, `period=daily${query}`)).json();
    assert.equal(body.entries.length, expected, query);
    assert.equal(body.totalRanked, 120, query);
  }
});

test("positionsLimit defaults to 3, clamps above 5, 0 counts only, largest value first", async () => {
  const a = app(new GroupBoardStore(dataset()));
  const g = async (query: string) =>
    (await get(a, `period=daily${query}`)).json().entries.find((e: any) => e.groupId === "g-b");
  const mints = (entry: any) => entry.topPositions.map((p: any) => p.mint);
  assert.deepEqual(mints(await g("")), ["mint-6", "mint-5", "mint-4"]);
  assert.equal((await g("&positionsLimit=9")).topPositions.length, 5);
  const countOnly = await g("&positionsLimit=0");
  assert.deepEqual(countOnly.topPositions, []);
  assert.equal(countOnly.positionsCount, 7);
  assert.equal((await g("&positionsLimit=1")).positionsCount, 7);
  assert.equal(Object.hasOwn((await g("")).topPositions[0], "valueUsd"), false);
});

test("strict queries reject missing, unknown, repeated and non-integer values", async () => {
  const a = app(new GroupBoardStore(dataset()));
  for (const query of [
    "", "period=hourly", "period=Daily", "period=daily&sort=best", "period=daily&limit=1.5",
    "period=daily&limit=abc", "period=daily&limit=", "period=daily&limit=-0", "period=daily&limit=01",
    "period=daily&positionsLimit=-1", "period=daily&positionsLimit=1e2",
    `period=daily&limit=${Number.MAX_SAFE_INTEGER + 2}`, "period=daily&period=daily", "period=daily&cursor=1",
  ]) {
    const res = await get(a, query);
    assert.equal(res.statusCode, 400, query);
    assert.deepEqual(res.json(), { statusCode: 400, error: "INVALID_QUERY" });
  }
});

test("a period without a supplied board is 501, never another period's board", async () => {
  const res = await get(app(new GroupBoardStore(dataset())), "period=weekly");
  assert.equal(res.statusCode, 501);
  assert.equal(res.json().reason, "GROUP_BOARD_UNAVAILABLE");
  assert.throws(() => new GroupBoardStore(dataset()).board({ period: "monthly" }), UnavailableGroupBoardError);
});

test("captured numeric period codes are served per period", () => {
  const d = dataset();
  d.boards.weekly = { periodLabel: "w", windowStartSec: 0, rows: [] };
  d.boards.monthly = { periodLabel: "m", windowStartSec: 0, rows: [] };
  const store = new GroupBoardStore(d);
  assert.equal(store.board({ period: "daily" }).periodType, 3);
  assert.equal(store.board({ period: "weekly" }).periodType, 1);
  assert.equal(store.board({ period: "monthly" }).periodType, 2);
  assert.deepEqual(store.board({ period: "weekly" }).entries, []);
});

test("the developer API-key gate still runs first", async () => {
  const res = await app(new GroupBoardStore(dataset())).inject({ method: "GET", url: `${path}?period=daily` });
  assert.equal(res.statusCode, 401);
});

test("without a store the documented route keeps fixture replay or 501", async () => {
  const fixture: Fixture = {
    method: "GET",
    path,
    query: { period: "daily" },
    status: 200,
    body: { entries: [], periodType: 3, periodLabel: "x", windowStartSec: 0, totalRanked: 0 },
    source: "synthetic test fixture",
  };
  assert.equal((await get(app(), "period=daily")).statusCode, 501);
  const replay = await get(app(undefined, [fixture]), "period=daily");
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.headers["x-reconstruction-data-source"], undefined);
  const native = await get(app(new GroupBoardStore(dataset()), [fixture]), "period=daily");
  assert.equal(native.json().totalRanked, 3);
});

test("malformed datasets fail at construction", () => {
  const cases: [string, (d: any) => void][] = [
    ["unknown period", (d) => { d.boards.hourly = d.boards.daily; }],
    ["duplicate group", (d) => { d.boards.daily.rows.push(row("g-a", 1, 1)); }],
    ["counted above members", (d) => { d.boards.daily.rows[0].membersCounted = 6; }],
    ["fractional count", (d) => { d.boards.daily.rows[0].memberCount = 1.5; }],
    ["non-finite measure", (d) => { d.boards.daily.rows[0].pnlUsd = Number.POSITIVE_INFINITY; }],
    ["string measure", (d) => { d.boards.daily.rows[0].pnlSol = "1"; }],
    ["future refresh", (d) => { d.boards.daily.rows[0].lastRefreshedAtMs = nowMs + 1; }],
    ["future window", (d) => { d.boards.daily.windowStartSec = nowMs / 1000 + 1; }],
    ["blank label", (d) => { d.boards.daily.periodLabel = ""; }],
    ["badge type", (d) => { d.boards.daily.rows[0].isVerified = "yes"; }],
    ["extra row key", (d) => { d.boards.daily.rows[0].xUsername = null; }],
    ["missing row key", (d) => { delete d.boards.daily.rows[0].username; }],
    ["duplicate position", (d) => { d.boards.daily.rows[0].positions[1].mint = "mint-0"; }],
    ["non-finite position value", (d) => { d.boards.daily.rows[0].positions[0].valueUsd = Number.NaN; }],
    ["sparse rows", (d) => { d.boards.daily.rows = new Array(2); }],
    ["bad source", (d) => { d.dataSource = "upstream"; }],
    ["bad observedAt", (d) => { d.observedAt = "2026-10-29"; }],
    // Shaped like toISOString output; Date.parse silently rolls it over to the next day.
    ["rolled-over observedAt", (d) => { d.observedAt = "2026-10-28T24:00:00.000Z"; }],
    ["extra root key", (d) => { d.extra = true; }],
  ];
  for (const [label, mutate] of cases) {
    const d = dataset();
    mutate(d);
    assert.throws(() => new GroupBoardStore(d), TypeError, label);
  }
});

test("the store owns its data against input and response mutation", () => {
  const d = dataset();
  const store = new GroupBoardStore(d);
  d.boards.daily!.rows[0].pnlUsd = 1e9;
  d.boards.daily!.rows[0].positions[0].mint = "mutated";
  const first = store.board({ period: "daily" });
  first.entries[2].topPositions[0].mint = "mutated";
  first.entries.reverse();
  const again = store.board({ period: "daily" });
  assert.deepEqual(again.entries.map((e) => e.groupId), ["g-c", "g-a", "g-b"]);
  assert.equal(again.entries[2].topPositions[0].mint, "mint-6");
});

test("the startup loader reads only a bounded regular file", () => {
  const dir = mkdtempSync(join(tmpdir(), "group-board-"));
  try {
    const file = join(dir, "board.json");
    writeFileSync(file, JSON.stringify(dataset()));
    assert.equal(loadGroupBoardStore(undefined), undefined);
    assert.equal(loadGroupBoardStore(file)!.board({ period: "daily" }).totalRanked, 3);
    const link = join(dir, "link.json");
    symlinkSync(file, link);
    assert.throws(() => loadGroupBoardStore(link));
    // Where O_NOFOLLOW is unavailable (Windows), the symlink is still refused.
    assert.throws(() => loadGroupBoardStore(link, 0), /file type/);
    assert.throws(() => loadGroupBoardStore(dir, 0), /file type/);
    assert.ok(loadGroupBoardStore(file, 0));
    writeFileSync(file, Buffer.from([0x7b, 0xff, 0x7d]));
    assert.throws(() => loadGroupBoardStore(file), TypeError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
