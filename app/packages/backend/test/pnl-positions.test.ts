import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildApp, type Fixture } from "../src/app.js";
import {
  PnlPositionsStore,
  loadPnlPositionsStore,
  type PnlPositionFact,
  type PnlPositionsDataset,
} from "../src/pnl-positions-store.js";
import { assertSchema } from "../src/schema-validator.js";

const now = "2026-10-29T00:00:00.000Z";
const nowMs = Date.parse(now);
// Synthetic shape-only credential for in-process compatibility-gate tests.
const headers = { authorization: `Bearer pf_live_${"a".repeat(49)}` };
const base = "/v1/pnl-leaderboard/positions";
const spec = JSON.parse(
  readFileSync(new URL("../../../contracts/developer.openapi.json", import.meta.url), "utf8"),
);
const okSchema =
  spec.paths["/pnl-leaderboard/positions"].get.responses["200"].content["application/json"].schema;

function callout(id: string): Record<string, unknown> {
  return {
    calloutId: id,
    calledOutAtMcap: 50_000,
    multiple: 2,
    thesis: null,
    mediaUrl: null,
    calloutTimestamp: "2026-10-28T00:00:00.000Z",
    likes: 3,
    hasLiked: null,
    updates: [],
    updateCount: 0,
    commentCount: 0,
    replyCount: 0,
    maxMultiplier: null,
    maxMultiplierAt: null,
    calloutPrice: 0.001,
    repostCount: 0,
    quoteCount: 0,
    hasReposted: null,
    actingUserId: null,
    actingUser: null,
    quotedCallout: null,
  };
}
function quoted(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    coinMint: "quoted-mint",
    walletAddress: null,
    userId: "quoted-user",
    userName: null,
    profileImage: null,
    isVerified: false,
    verifiedBadgeVisible: false,
    accountKind: "person",
    xUsername: null,
    xFollowerCount: 0,
    mediaUrl: null,
    callout: { ...callout("quoted"), ...overrides },
  };
}
function row(n: number, profiled = true): PnlPositionFact {
  return {
    walletAddress: `wallet-${n}`,
    coinMint: `mint-${n}`,
    pnlUsd: 1000 - n,
    pnlPercentage: null,
    amountHeld: 10,
    isExited: false,
    costBasisAmount: null,
    costBasisUsd: 100,
    amountBoughtUsd: 100,
    amountBought: 10,
    realizedPnlUsd: null,
    avgEntryMcapUsd: null,
    callout: callout(`callout-${n}`),
    leaderboardPnlUsd: 1000 - n,
    heldValueSol: 1.5,
    valueUsd: null,
    lastRefreshedAtMs: nowMs - 1000,
    profile: profiled
      ? {
          username: `user-${n}`,
          profileImage: null,
          xUsername: null,
          isVerified: n === 1,
          verifiedBadgeVisible: n === 1,
          userId: `uid-${n}`,
        }
      : null,
  };
}
function dataset(rows = 3): PnlPositionsDataset {
  return {
    schemaVersion: 1,
    dataSource: "synthetic",
    observedAt: now,
    boards: {
      daily: {
        periodLabel: "2026-10-28",
        windowStartSec: nowMs / 1000 - 86_400,
        rows: Array.from({ length: rows }, (_, index) => row(index + 1)),
      },
    },
  };
}
function app(store?: PnlPositionsStore, fixtures: Fixture[] = []) {
  return buildApp(fixtures, store ? { pnlPositionsStore: store } : {});
}
function get(server: ReturnType<typeof buildApp>, query: string) {
  return server.inject({ method: "GET", url: `${base}${query}`, headers });
}

test("the declared contract text is the pinned captured range", () => {
  // Read and hash only; captured code is never imported or executed.
  const source = readFileSync(
    new URL("../../../evidence/web/objects/2b47dd0b38a1608f.js", import.meta.url),
    "utf8",
  );
  const route = source.slice(311462, 312223);
  const rows = source.slice(306985, 308626);
  assert.equal(createHash("sha256").update(route).digest("hex"), "0a7fe19ecc166a10c4cd98c2ba42d5b2d615e2aaad61efbb9b2791885cf62c97");
  assert.equal(createHash("sha256").update(rows).digest("hex"), "6f635e524ccafb37178a118f7a12df149540952300e18a98d7893556902e2840");
  for (const phrase of [
    'period:o.z.enum(["daily","weekly"])',
    "the API host has no viewer, so followedHolders is null there",
    "default 3; values above 10 clamp to 10",
    "Rows served; default and ceiling 25",
    "totalRanked:o.z.number()",
  ])
    assert.ok(route.includes(phrase), phrase);
  assert.ok(rows.includes("Never null — a row without a callout is dropped from the board"));
  assert.ok(rows.includes("Profile fields are present only when the board had at least one wallet to enrich"));
});

test("a supplied board is served in supplied rank order with profiles", async () => {
  const res = await get(app(new PnlPositionsStore(dataset())), "?period=daily");
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-reconstruction-data-source"], "synthetic");
  assert.equal(res.headers["x-reconstruction-observed-at"], now);
  assert.equal(res.headers["x-reconstruction-compatibility"], "unqualified");
  const body = res.json();
  assertSchema(body, okSchema, "positions", spec);
  assert.deepEqual(body.entries.map((entry: any) => [entry.rank, entry.walletAddress]), [
    [1, "wallet-1"],
    [2, "wallet-2"],
    [3, "wallet-3"],
  ]);
  assert.equal(body.totalRanked, 3);
  assert.equal(body.periodLabel, "2026-10-28");
  assert.equal(body.windowStartSec, nowMs / 1000 - 86_400);
  const [first] = body.entries;
  assert.equal(first.username, "user-1");
  assert.equal(first.userId, "uid-1");
  assert.equal(first.isVerified, true);
  assert.equal(first.callout.calloutId, "callout-1");
  for (const key of ["profile", "followedHolders", "isViewer", "viewerFollows", "receiptBasisUsd", "resolvedAvatarDecoration"])
    assert.equal(Object.hasOwn(first, key), false, key);
});

test("the producer's order is the rank, never a re-sort on a measure", async () => {
  const d = dataset();
  d.boards.daily!.rows.reverse();
  const body = (await get(app(new PnlPositionsStore(d)), "?period=daily")).json();
  assert.deepEqual(body.entries.map((entry: any) => [entry.rank, entry.walletAddress]), [
    [1, "wallet-3"],
    [2, "wallet-2"],
    [3, "wallet-1"],
  ]);
});

test("a viewerless one-level quoted callout is served as supplied", async () => {
  const d = dataset();
  d.boards.daily!.rows[0].callout.quotedCallout = quoted();
  const body = (await get(app(new PnlPositionsStore(d)), "?period=daily")).json();
  assertSchema(body, okSchema, "quoted", spec);
  assert.deepEqual(body.entries[0].callout.quotedCallout, quoted());
});

test("a board without enrichment serves no profile fields", async () => {
  const d = dataset();
  d.boards.daily!.rows = [row(1, false), row(2, false)];
  const body = (await get(app(new PnlPositionsStore(d)), "?period=daily")).json();
  assertSchema(body, okSchema, "unenriched", spec);
  for (const key of ["username", "profileImage", "xUsername", "isVerified", "verifiedBadgeVisible", "userId"])
    assert.equal(Object.hasOwn(body.entries[0], key), false, key);
});

test("limit defaults to and clamps at 25, negatives clamp to none", async () => {
  const server = app(new PnlPositionsStore(dataset(30)));
  const cases: [string, number][] = [["", 25], ["&limit=25", 25], ["&limit=100", 25], ["&limit=2", 2], ["&limit=0", 0], ["&limit=-4", 0]];
  for (const [query, size] of cases) {
    const body = (await get(server, `?period=daily${query}`)).json();
    assertSchema(body, okSchema, query, spec);
    assert.equal(body.entries.length, size, query);
    assert.equal(body.totalRanked, 30, query);
    if (size) assert.equal(body.entries.at(-1).rank, size, query);
  }
});

test("opting into followed holders is null on the viewerless API host", async () => {
  const server = app(new PnlPositionsStore(dataset()));
  for (const query of ["&includeFollowedHolders=true", "&includeFollowedHolders=true&followedHoldersLimit=50"]) {
    const body = (await get(server, `?period=daily${query}`)).json();
    assertSchema(body, okSchema, query, spec);
    assert.ok(body.entries.every((entry: any) => Object.hasOwn(entry, "followedHolders") && entry.followedHolders === null));
  }
  for (const query of ["", "&includeFollowedHolders=false", "&followedHoldersLimit=2"]) {
    const body = (await get(server, `?period=daily${query}`)).json();
    assert.ok(body.entries.every((entry: any) => !Object.hasOwn(entry, "followedHolders")), query);
  }
});

test("an unsupplied period is a 501, never another period's board", async () => {
  const res = await get(app(new PnlPositionsStore(dataset())), "?period=weekly");
  assert.equal(res.statusCode, 501);
  assert.deepEqual(res.json(), {
    statusCode: 501,
    error: "COMPATIBILITY_NOT_IMPLEMENTED",
    reason: "PNL_POSITIONS_BOARD_UNAVAILABLE",
  });
});

test("strict queries reject unknown, repeated and malformed values", async () => {
  const server = app(new PnlPositionsStore(dataset()));
  for (const query of [
    "",
    "?period=monthly",
    "?period=DAILY",
    "?period=daily&period=daily",
    "?period=daily&sort=combined",
    "?period=daily&limit=1.5",
    "?period=daily&limit=+1",
    "?period=daily&limit=01",
    "?period=daily&limit=",
    "?period=daily&limit=99999999999999999999",
    "?period=daily&includeFollowedHolders=1",
    "?period=daily&includeFollowedHolders=TRUE",
    "?period=daily&followedHoldersLimit=0",
    "?period=daily&followedHoldersLimit=-1",
  ]) {
    const res = await get(server, query);
    assert.equal(res.statusCode, 400, query);
    assert.deepEqual(res.json(), { statusCode: 400, error: "INVALID_QUERY" }, query);
  }
});

test("the developer API-key gate still runs first", async () => {
  const res = await app(new PnlPositionsStore(dataset())).inject({ method: "GET", url: `${base}?period=daily` });
  assert.equal(res.statusCode, 401);
});

test("without a store the documented route keeps fixture replay or 501", async () => {
  const fixture: Fixture = {
    method: "GET",
    path: base,
    query: { period: "daily" },
    status: 200,
    body: { entries: [], periodLabel: "x", windowStartSec: 0, totalRanked: 0 },
    source: "synthetic test fixture",
  };
  assert.equal((await get(app(), "?period=daily")).statusCode, 501);
  const replay = await get(app(undefined, [fixture]), "?period=daily");
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.headers["x-reconstruction-data-source"], undefined);
  const native = await get(app(new PnlPositionsStore(dataset()), [fixture]), "?period=daily");
  assert.equal(native.json().entries.length, 3);
});

test("malformed datasets fail at construction", () => {
  const mutations: [string, (d: any) => void][] = [
    ["extra root key", (d) => { d.extra = 1; }],
    ["version", (d) => { d.schemaVersion = 2; }],
    ["source", (d) => { d.dataSource = "live"; }],
    ["non-canonical observedAt", (d) => { d.observedAt = "2026-10-29T00:00:00Z"; }],
    ["monthly board", (d) => { d.boards.monthly = d.boards.daily; }],
    ["future window", (d) => { d.boards.daily.windowStartSec = nowMs / 1000 + 1; }],
    ["extra board key", (d) => { d.boards.daily.extra = 1; }],
    ["extra row key", (d) => { d.boards.daily.rows[0].receiptBasisUsd = 1; }],
    ["missing row key", (d) => { delete d.boards.daily.rows[0].valueUsd; }],
    ["null callout", (d) => { d.boards.daily.rows[0].callout = null; }],
    ["callout extra key", (d) => { d.boards.daily.rows[0].callout.extra = 1; }],
    ["callout missing key", (d) => { delete d.boards.daily.rows[0].callout.likes; }],
    ["viewer like", (d) => { d.boards.daily.rows[0].callout.hasLiked = false; }],
    ["viewer repost", (d) => { d.boards.daily.rows[0].callout.hasReposted = true; }],
    ["quoted viewer like", (d) => {
      d.boards.daily.rows[0].callout.quotedCallout = quoted({ hasLiked: true });
    }],
    ["quoted viewer repost", (d) => {
      d.boards.daily.rows[0].callout.quotedCallout = quoted({ hasReposted: false });
    }],
    ["quote nested two levels", (d) => {
      d.boards.daily.rows[0].callout.quotedCallout = quoted({ quotedCallout: quoted() });
    }],
    ["duplicate position", (d) => { d.boards.daily.rows[1].walletAddress = "wallet-1"; d.boards.daily.rows[1].coinMint = "mint-1"; }],
    ["NaN measure", (d) => { d.boards.daily.rows[0].pnlUsd = Number.NaN; }],
    ["null leaderboard pnl", (d) => { d.boards.daily.rows[0].leaderboardPnlUsd = null; }],
    ["string isExited", (d) => { d.boards.daily.rows[0].isExited = "no"; }],
    ["future refresh", (d) => { d.boards.daily.rows[0].lastRefreshedAtMs = nowMs + 1; }],
    ["empty wallet", (d) => { d.boards.daily.rows[0].walletAddress = ""; }],
    ["partial profile", (d) => { delete d.boards.daily.rows[0].profile.userId; }],
    ["mixed enrichment", (d) => { d.boards.daily.rows[1].profile = null; }],
    ["hole in rows", (d) => { d.boards.daily.rows = [row(1), , row(3)]; }],
  ];
  assert.doesNotThrow(() => new PnlPositionsStore(dataset()));
  for (const [label, mutate] of mutations) {
    const d = structuredClone(dataset()) as any;
    mutate(d);
    assert.throws(() => new PnlPositionsStore(d), TypeError, label);
  }
});

test("the store owns its data against input and response mutation", async () => {
  const d = dataset();
  const store = new PnlPositionsStore(d);
  d.boards.daily!.rows[0].walletAddress = "changed";
  (d.boards.daily!.rows[0].callout as any).likes = 999;
  d.boards.daily!.rows[0].profile!.username = "changed";
  const first = store.board({ period: "daily" });
  (first.entries[0].callout as any).likes = 777;
  first.entries[0].walletAddress = "mutated";
  const second = store.board({ period: "daily" });
  assert.equal(second.entries[0].walletAddress, "wallet-1");
  assert.equal((second.entries[0].callout as any).likes, 3);
  assert.equal(second.entries[0].username, "user-1");
});

test("the startup loader reads only a bounded regular file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pnl-positions-"));
  try {
    const file = join(dir, "positions.json");
    writeFileSync(file, JSON.stringify(dataset()));
    assert.equal(loadPnlPositionsStore(undefined), undefined);
    assert.equal(loadPnlPositionsStore(file)!.board({ period: "daily" }).entries.length, 3);
    const link = join(dir, "link.json");
    symlinkSync(file, link);
    assert.throws(() => loadPnlPositionsStore(link));
    // Where O_NOFOLLOW is unavailable (Windows), the symlink is still refused.
    assert.throws(() => loadPnlPositionsStore(link, 0), /file type/);
    assert.throws(() => loadPnlPositionsStore(dir, 0), /file type/);
    assert.ok(loadPnlPositionsStore(file, 0));
    writeFileSync(file, Buffer.from([0x7b, 0xff, 0x7d]));
    assert.throws(() => loadPnlPositionsStore(file), TypeError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
