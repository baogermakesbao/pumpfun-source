import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildApp, type Fixture } from "../src/app.js";
import {
  UserAchievementsStore,
  loadUserAchievementsStore,
  type UserAchievementsDataset,
} from "../src/user-achievements-store.js";
import { assertSchema } from "../src/schema-validator.js";

const now = "2026-10-29T00:00:00.000Z";
// Synthetic shape-only credential for in-process compatibility-gate tests.
const headers = { authorization: `Bearer pf_live_${"a".repeat(49)}` };
const spec = JSON.parse(
  readFileSync(new URL("../../../contracts/developer.openapi.json", import.meta.url), "utf8"),
);
const okSchema =
  spec.paths["/users/{address}/achievements"].get.responses["200"].content["application/json"].schema;
const calloutId = "0b5f3c1e-8d2a-4f6b-9c7e-1a2b3c4d5e6f";

function dataset(): UserAchievementsDataset {
  return {
    schemaVersion: 1,
    dataSource: "synthetic",
    observedAt: now,
    catalog: { version: "cat-v7", order: ["first-call", "multiple-10x", "multiple-100x", "weekly-podium", "calls-10", "calls-100"] },
    users: {
      Wallet1: {
        achievements: [
          { achievementId: "first-call", unlockedAt: "2026-01-02T03:04:05.006Z", value: 1, holderCount: 9000, holderPercent: 45.5, evidence: null },
          {
            achievementId: "multiple-10x",
            unlockedAt: "2026-03-01T00:00:00.000Z",
            value: 12,
            holderCount: 1,
            holderPercent: null,
            evidence: {
              kind: "callout",
              callout: { calloutId, mint: "MintA", multiple: 14, calledOutAt: "2026-02-01T00:00:00.000Z", peakedAt: "2026-02-20T00:00:00.000Z" },
              leaderboard: null,
            },
          },
          {
            achievementId: "weekly-podium",
            unlockedAt: null,
            value: null,
            holderCount: null,
            holderPercent: null,
            evidence: {
              kind: "leaderboard",
              callout: null,
              leaderboard: {
                finishes: [
                  // ISO 2026-W01 starts Monday 29 December 2025.
                  { periodType: "weekly", periodLabel: "2026-W01", rank: 2, periodStart: "2025-12-29T00:00:00.000Z" },
                  { periodType: "monthly", periodLabel: "2026-08", rank: 3, periodStart: "2026-08-01T00:00:00.000Z" },
                  { periodType: "weekly", periodLabel: "2026-W37", rank: 1, periodStart: null },
                ],
              },
            },
          },
        ],
        progress: [
          { metric: "callouts", currentValue: 42, nextThreshold: 100, nextAchievementId: "calls-100", previousThreshold: 10, previousAchievementId: "calls-10" },
          { metric: "peak_multiple", currentValue: 140, nextThreshold: null, nextAchievementId: null, previousThreshold: 100, previousAchievementId: "multiple-100x" },
          { metric: "new_track", currentValue: 0, nextThreshold: 1, nextAchievementId: "first-call", previousThreshold: null, previousAchievementId: null },
        ],
      },
      Fresh: { achievements: [], progress: [] },
    },
  };
}
function app(store?: UserAchievementsStore, fixtures: Fixture[] = []) {
  return buildApp(fixtures, store ? { userAchievementsStore: store } : {});
}
function get(server: ReturnType<typeof buildApp>, address: string, query = "") {
  return server.inject({ method: "GET", url: `/v1/users/${address}/achievements${query}`, headers });
}

test("the declared contract text is the pinned captured ranges", () => {
  // Read and hash only; captured code is never imported or executed.
  const source = readFileSync(
    new URL("../../../evidence/web/objects/2b47dd0b38a1608f.js", import.meta.url),
    "utf8",
  );
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const route = source.slice(419546, 420273);
  assert.equal(hash(route), "79f133035bf435d72eff0707645a28298191da9ef4f6d43d97f32039dad0cffd");
  for (const phrase of [
    '"GET /users/{address}/achievements":(0,s.publicRead)("profiles.read"',
    "`seen` is viewer-relative, served only to the signed-in owner and absent on the API host",
    "params:o.z.object({address:o.z.string()})",
    "ordered by catalog sortOrder",
    "empty when the response is a degraded fallback",
  ])
    assert.ok(route.includes(phrase), phrase);
  assert.ok(!route.includes("query:"));
  const schemas = source.slice(410637, 414076);
  assert.equal(hash(schemas), "62ba3fa2189095310482d1945eda5f4a48c1fd2323436e891580916e5505fecf");
  for (const phrase of [
    "The callout credited with the tier (UUID).",
    "The callout's whole-number peak multiple at read time",
    'ISO week label ("2026-W37") or calendar month ("2026-08").',
    "Monday 00:00 for a week, the 1st for a month",
    "chronological and capped at the rule's own count. Never empty.",
    "Always false for anonymous and third-party viewers.",
    "never below 1 for a holder",
    "holderCount as a percentage (0-100) of all accounts",
    "Null whenever holderCount is",
    "Threshold of the next locked tier; null when the track is maxed out.",
    "null when no tier is reached yet",
  ])
    assert.ok(schemas.includes(phrase), phrase);
});

test("supplied unlocks and progress are served with seen=false and the catalog version", async () => {
  const res = await get(app(new UserAchievementsStore(dataset())), "Wallet1");
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-reconstruction-data-source"], "synthetic");
  assert.equal(res.headers["x-reconstruction-observed-at"], now);
  assert.equal(res.headers["x-reconstruction-compatibility"], "unqualified");
  const body = res.json();
  assertSchema(body, okSchema, "achievements", spec);
  assert.equal(body.catalogVersion, "cat-v7");
  assert.deepEqual(body.achievements.map((row: any) => [row.achievementId, row.seen]), [
    ["first-call", false],
    ["multiple-10x", false],
    ["weekly-podium", false],
  ]);
  const expected = dataset().users.Wallet1;
  assert.deepEqual(
    body.achievements.map(({ seen: _seen, ...rest }: any) => rest),
    expected.achievements,
  );
  assert.deepEqual(body.progress, expected.progress);
});

test("a supplied user with nothing unlocked is an empty 200; an unsupplied user is a 501", async () => {
  const server = app(new UserAchievementsStore(dataset()));
  const fresh = await get(server, "Fresh");
  assert.equal(fresh.statusCode, 200);
  assertSchema(fresh.json(), okSchema, "fresh", spec);
  assert.deepEqual(fresh.json(), { achievements: [], progress: [], catalogVersion: "cat-v7" });
  for (const address of ["Unknown", "wallet1"]) {
    const res = await get(server, address);
    assert.equal(res.statusCode, 501, address);
    assert.deepEqual(res.json(), {
      statusCode: 501,
      error: "COMPATIBILITY_NOT_IMPLEMENTED",
      reason: "USER_ACHIEVEMENTS_UNAVAILABLE",
    });
  }
});

test("the operation declares no query parameters", async () => {
  const server = app(new UserAchievementsStore(dataset()));
  for (const query of ["?viewer=Wallet1", "?seen=true", "?limit=1", "?", "?=", "?a"]) {
    const res = await get(server, "Wallet1", query);
    const expected = query === "?" ? 200 : 400;
    assert.equal(res.statusCode, expected, query);
    if (expected === 400) assert.deepEqual(res.json(), { statusCode: 400, error: "INVALID_QUERY" }, query);
  }
});

test("the developer API-key gate still runs first", async () => {
  const res = await app(new UserAchievementsStore(dataset())).inject({ method: "GET", url: "/v1/users/Wallet1/achievements" });
  assert.equal(res.statusCode, 401);
});

test("sibling user routes are unaffected", async () => {
  const server = app(new UserAchievementsStore(dataset()));
  const overview = await server.inject({ method: "GET", url: "/v1/users/Wallet1/overview", headers });
  assert.notEqual(overview.headers["x-reconstruction-data-source"], "synthetic");
});

test("without a store the documented route keeps fixture replay or 501", async () => {
  const fixture: Fixture = {
    method: "GET",
    path: "/v1/users/Wallet1/achievements",
    status: 200,
    body: { achievements: [], progress: [], catalogVersion: "" },
    source: "synthetic test fixture",
  };
  assert.equal((await get(app(), "Wallet1")).statusCode, 501);
  const replay = await get(app(undefined, [fixture]), "Wallet1");
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.headers["x-reconstruction-data-source"], undefined);
  const native = await get(app(new UserAchievementsStore(dataset()), [fixture]), "Wallet1");
  assert.equal(native.json().catalogVersion, "cat-v7");
});

test("ISO week and month periods are checked against their labels", () => {
  const accepted: [string, string, string][] = [
    ["weekly", "2026-W01", "2025-12-29T00:00:00.000Z"],
    ["weekly", "2020-W53", "2020-12-28T00:00:00.000Z"],
    ["weekly", "2025-W01", "2024-12-30T00:00:00.000Z"],
    ["monthly", "2026-02", "2026-02-01T00:00:00.000Z"],
    ["monthly", "2025-12", "2025-12-01T00:00:00.000Z"],
  ];
  for (const [periodType, periodLabel, periodStart] of accepted) {
    const d = dataset() as any;
    d.users.Wallet1.achievements[2].evidence.leaderboard.finishes = [{ periodType, periodLabel, rank: 1, periodStart }];
    assert.doesNotThrow(() => new UserAchievementsStore(d), periodLabel);
  }
  const rejected: [string, string, string | null][] = [
    ["weekly", "2025-W53", null], // 2025 has 52 ISO weeks
    ["weekly", "2026-W00", null],
    ["weekly", "2026-W1", null],
    ["weekly", "2026-08", null],
    ["monthly", "2026-W01", null],
    ["monthly", "2026-13", null],
    ["monthly", "2026-8", null],
    ["weekly", "2026-W01", "2026-01-01T00:00:00.000Z"], // calendar day, not the ISO Monday
    ["monthly", "2026-08", "2026-08-02T00:00:00.000Z"],
    ["monthly", "2026-08", "2026-08-01T00:00:00Z"],
    ["daily", "2026-08-01", null],
    ["weekly", "2026-W44", null], // still open at the snapshot
    ["monthly", "2026-10", null],
  ];
  for (const [periodType, periodLabel, periodStart] of rejected) {
    const d = dataset() as any;
    d.users.Wallet1.achievements[2].evidence.leaderboard.finishes = [{ periodType, periodLabel, rank: 1, periodStart }];
    assert.throws(() => new UserAchievementsStore(d), TypeError, `${periodType} ${periodLabel} ${periodStart}`);
  }
  // The week that closed just before the snapshot is accepted.
  const d = dataset() as any;
  d.users.Wallet1.achievements[2].evidence.leaderboard.finishes = [
    { periodType: "weekly", periodLabel: "2026-W43", rank: 1, periodStart: "2026-10-19T00:00:00.000Z" },
    { periodType: "monthly", periodLabel: "2026-09", rank: 1, periodStart: null },
  ].reverse();
  assert.doesNotThrow(() => new UserAchievementsStore(d));
});

test("malformed datasets fail at construction", () => {
  const user = (d: any) => d.users.Wallet1;
  const unlock = (d: any, index: number) => user(d).achievements[index];
  const callout = (d: any) => unlock(d, 1).evidence.callout;
  const finishes = (d: any) => unlock(d, 2).evidence.leaderboard.finishes;
  const progress = (d: any, index: number) => user(d).progress[index];
  const mutations: [string, (d: any) => void][] = [
    ["extra root key", (d) => { d.extra = 1; }],
    ["version", (d) => { d.schemaVersion = 2; }],
    ["source", (d) => { d.dataSource = "live"; }],
    ["non-canonical observedAt", (d) => { d.observedAt = "2026-10-29T00:00:00Z"; }],
    ["empty catalog version", (d) => { d.catalog.version = ""; }],
    ["extra catalog key", (d) => { d.catalog.retired = []; }],
    // An id nothing is ordered by, so only the duplicate itself can reject it.
    ["duplicate catalog id", (d) => { d.catalog.order.push("calls-100"); }],
    ["empty catalog id", (d) => { d.catalog.order.push(""); }],
    ["users array", (d) => { d.users = []; }],
    ["extra user key", (d) => { user(d).socials = []; }],
    ["supplied seen", (d) => { unlock(d, 0).seen = true; }],
    ["missing unlock key", (d) => { delete unlock(d, 0).value; }],
    ["unknown achievement", (d) => { unlock(d, 0).achievementId = "retired"; }],
    ["unlocks out of sort order", (d) => { user(d).achievements.reverse(); }],
    ["duplicate unlock", (d) => { user(d).achievements[1] = structuredClone(unlock(d, 0)); }],
    ["unlock after snapshot", (d) => { unlock(d, 0).unlockedAt = "2026-10-29T00:00:00.001Z"; }],
    ["unlock without ms", (d) => { unlock(d, 0).unlockedAt = "2026-01-02T03:04:05Z"; }],
    ["NaN value", (d) => { unlock(d, 0).value = Number.NaN; }],
    ["zero holders", (d) => { unlock(d, 0).holderCount = 0; }],
    ["fractional holders", (d) => { unlock(d, 0).holderCount = 1.5; }],
    ["percent without holders", (d) => { unlock(d, 0).holderCount = null; }],
    ["percent over 100", (d) => { unlock(d, 0).holderPercent = 100.1; }],
    ["negative percent", (d) => { unlock(d, 0).holderPercent = -0.1; }],
    ["unknown evidence kind", (d) => { unlock(d, 1).evidence.kind = "count"; }],
    ["callout kind with leaderboard arm", (d) => { unlock(d, 1).evidence.leaderboard = { finishes: structuredClone(finishes(d)) }; }],
    ["callout kind without callout", (d) => { unlock(d, 1).evidence.callout = null; }],
    ["leaderboard kind with callout arm", (d) => { unlock(d, 2).evidence.callout = structuredClone(callout(d)); }],
    ["leaderboard kind without board", (d) => { unlock(d, 2).evidence.leaderboard = null; }],
    ["extra evidence key", (d) => { unlock(d, 1).evidence.extra = 1; }],
    ["non-UUID callout", (d) => { callout(d).calloutId = "callout-1"; }],
    ["empty mint", (d) => { callout(d).mint = ""; }],
    ["fractional multiple", (d) => { callout(d).multiple = 14.5; }],
    ["zero multiple", (d) => { callout(d).multiple = 0; }],
    ["peak before call", (d) => { callout(d).peakedAt = "2026-01-31T23:59:59.999Z"; }],
    ["call after snapshot", (d) => { callout(d).calledOutAt = "2026-10-29T00:00:00.001Z"; callout(d).peakedAt = null; }],
    ["peak after snapshot", (d) => { callout(d).peakedAt = "2026-10-29T00:00:00.001Z"; }],
    ["empty finishes", (d) => { unlock(d, 2).evidence.leaderboard.finishes = []; }],
    ["finishes out of order", (d) => { finishes(d).reverse(); }],
    ["duplicate finish", (d) => { finishes(d).push({ ...finishes(d)[2], rank: 4 }); }],
    ["zero rank", (d) => { finishes(d)[0].rank = 0; }],
    ["fractional rank", (d) => { finishes(d)[0].rank = 1.5; }],
    ["extra finish key", (d) => { finishes(d)[0].score = 1; }],
    ["extra board key", (d) => { unlock(d, 2).evidence.leaderboard.extra = 1; }],
    ["extra progress key", (d) => { progress(d, 0).family = "trader"; }],
    ["duplicate metric", (d) => { progress(d, 1).metric = "callouts"; }],
    ["empty metric", (d) => { progress(d, 1).metric = ""; }],
    ["numeric metric", (d) => { progress(d, 1).metric = 7; }],
    ["NaN current value", (d) => { progress(d, 0).currentValue = Number.NaN; }],
    ["next id without threshold", (d) => { progress(d, 0).nextThreshold = null; }],
    ["next threshold without id", (d) => { progress(d, 0).nextAchievementId = null; }],
    ["previous id without threshold", (d) => { progress(d, 0).previousThreshold = null; }],
    ["previous threshold without id", (d) => { progress(d, 0).previousAchievementId = null; }],
    ["unknown next tier", (d) => { progress(d, 0).nextAchievementId = "calls-1000"; }],
    ["unknown previous tier", (d) => { progress(d, 0).previousAchievementId = "calls-1"; }],
    ["inverted rung", (d) => { progress(d, 0).previousThreshold = 100; }],
    ["same tier both ends", (d) => { progress(d, 0).nextAchievementId = "calls-10"; }],
    ["hole in progress", (d) => { user(d).progress = [progress(d, 0), , progress(d, 2)]; }],
  ];
  assert.doesNotThrow(() => new UserAchievementsStore(dataset()));
  for (const [label, mutate] of mutations) {
    const d = structuredClone(dataset()) as any;
    mutate(d);
    assert.throws(() => new UserAchievementsStore(d), TypeError, label);
  }
});

test("boundary values the contract allows are accepted", () => {
  const d = dataset() as any;
  const first = d.users.Wallet1.achievements[0];
  Object.assign(first, { unlockedAt: now, holderCount: 1, holderPercent: 0, value: -3.5 });
  d.users.Wallet1.achievements[1].holderPercent = 100;
  Object.assign(d.users.Wallet1.achievements[1].evidence.callout, {
    calledOutAt: now,
    peakedAt: now,
    calloutId: calloutId.toUpperCase(),
  });
  d.users.Wallet1.progress[0].currentValue = -1;
  assert.doesNotThrow(() => new UserAchievementsStore(d));
  const nulls = dataset() as any;
  Object.assign(nulls.users.Wallet1.achievements[1].evidence.callout, { calledOutAt: null, peakedAt: null });
  assert.doesNotThrow(() => new UserAchievementsStore(nulls));
});

test("the store owns its data against input and response mutation", () => {
  const d = dataset();
  const store = new UserAchievementsStore(d);
  d.users.Wallet1.achievements[1].evidence!.callout!.mint = "changed";
  d.users.Wallet1.achievements[2].evidence!.leaderboard!.finishes[0].rank = 99;
  d.users.Wallet1.progress[0].currentValue = 99;
  d.catalog.version = "changed";
  const first = store.achievements("Wallet1");
  first.achievements[1].evidence!.callout!.mint = "mutated";
  first.achievements[2].evidence!.leaderboard!.finishes[0].rank = 77;
  first.achievements[0].seen = true;
  first.progress[0].currentValue = 77;
  first.achievements.pop();
  const second = store.achievements("Wallet1");
  assert.equal(second.achievements.length, 3);
  assert.equal(second.achievements[0].seen, false);
  assert.equal(second.achievements[1].evidence!.callout!.mint, "MintA");
  assert.equal(second.achievements[2].evidence!.leaderboard!.finishes[0].rank, 2);
  assert.equal(second.progress[0].currentValue, 42);
  assert.equal(second.catalogVersion, "cat-v7");
});

test("the startup loader reads only a bounded regular file", () => {
  const dir = mkdtempSync(join(tmpdir(), "user-achievements-"));
  try {
    const file = join(dir, "achievements.json");
    writeFileSync(file, JSON.stringify(dataset()));
    assert.equal(loadUserAchievementsStore(undefined), undefined);
    assert.equal(loadUserAchievementsStore(file)!.achievements("Wallet1").achievements.length, 3);
    const link = join(dir, "link.json");
    symlinkSync(file, link);
    assert.throws(() => loadUserAchievementsStore(link));
    // Where O_NOFOLLOW is unavailable (Windows), the symlink is still refused.
    assert.throws(() => loadUserAchievementsStore(link, 0), /file type/);
    assert.throws(() => loadUserAchievementsStore(dir, 0), /file type/);
    assert.ok(loadUserAchievementsStore(file, 0));
    writeFileSync(file, Buffer.from([0x7b, 0xff, 0x7d]));
    assert.throws(() => loadUserAchievementsStore(file), TypeError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
