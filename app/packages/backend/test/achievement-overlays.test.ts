import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildApp } from "../src/app.js";
import {
  AchievementOverlaysStore,
  loadAchievementOverlaysStore,
  type AchievementOverlaysDataset,
} from "../src/achievement-overlays-store.js";
import { assertSchema } from "../src/schema-validator.js";

const now = "2026-10-29T00:00:00.000Z";
// Synthetic shape-only credential for in-process compatibility-gate tests.
const headers = { authorization: `Bearer pf_live_${"a".repeat(49)}` };
const spec = JSON.parse(
  readFileSync(new URL("../../../contracts/developer.openapi.json", import.meta.url), "utf8"),
);
const okSchema =
  spec.paths["/achievements/overlays"].post.responses["201"].content["application/json"].schema;
const solana = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const evm = "0x" + "aB".repeat(20);
const userId = "0b5f3c1e-8d2a-4f6b-9c7e-1a2b3c4d5e6f";
const quiet = "11111111111111111111111111111111";

function dataset(): AchievementOverlaysDataset {
  return {
    schemaVersion: 1,
    dataSource: "synthetic",
    observedAt: now,
    overlays: {
      [solana]: ["multiple-100x", "weekly-podium", "first-call"],
      [evm]: ["first-call"],
      [userId]: ["calls-10", "first-call"],
      [quiet]: [],
    },
  };
}
function app(store?: AchievementOverlaysStore) {
  return buildApp([], store ? { achievementOverlaysStore: store } : {});
}
function post(server: ReturnType<typeof buildApp>, payload: unknown, query = "") {
  return server.inject({ method: "POST", url: `/v1/achievements/overlays${query}`, headers, payload: payload as any });
}

test("the declared contract text is the pinned captured range", () => {
  // Read and hash only; captured code is never imported or executed.
  const source = readFileSync(
    new URL("../../../evidence/web/objects/2b47dd0b38a1608f.js", import.meta.url),
    "utf8",
  );
  const route = source.slice(39484, 39939);
  assert.equal(createHash("sha256").update(route).digest("hex"), "7b4d99187f4dea55302bfbba79112f71b3aba557730ac10cd523e0ee9355d3a2");
  for (const phrase of [
    '"POST /achievements/overlays":(0,s.publicRead)("profiles.read"',
    "ids:o.z.array(o.z.string().max(64)).min(1).max(100)",
    "Wallet addresses (Solana base58 or EVM 0x) or user ids (UUID), disambiguated by format.",
    "response:o.z.record(o.z.string(),o.z.array(o.z.string()))",
    "ids with no unlocks are an empty array",
  ])
    assert.ok(route.includes(phrase), phrase);
  assert.ok(!route.includes("query:"));
});

test("supplied overlays are served as a 201 map in the producer's badge order", async () => {
  const res = await post(app(new AchievementOverlaysStore(dataset())), { ids: [userId, solana, evm, quiet] });
  assert.equal(res.statusCode, 201);
  assert.equal(res.headers["x-reconstruction-data-source"], "synthetic");
  assert.equal(res.headers["x-reconstruction-observed-at"], now);
  assert.equal(res.headers["x-reconstruction-compatibility"], "unqualified");
  const body = res.json();
  assertSchema(body, okSchema, "overlays", spec);
  assert.deepEqual(body, {
    [userId]: ["calls-10", "first-call"],
    [solana]: ["multiple-100x", "weekly-podium", "first-call"],
    [evm]: ["first-call"],
    [quiet]: [],
  });
  // Keys follow request order.
  assert.deepEqual(Object.keys(body), [userId, solana, evm, quiet]);
});

test("a repeated id is served once", async () => {
  const res = await post(app(new AchievementOverlaysStore(dataset())), { ids: [evm, evm, quiet] });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.json(), { [evm]: ["first-call"], [quiet]: [] });
});

test("any unsupplied id makes the whole batch a 501", async () => {
  const server = app(new AchievementOverlaysStore(dataset()));
  for (const ids of [
    [solana, "22222222222222222222222222222222"],
    [evm.toLowerCase()],
    [userId.toUpperCase()],
  ]) {
    const res = await post(server, { ids });
    assert.equal(res.statusCode, 501, ids.join());
    assert.deepEqual(res.json(), {
      statusCode: 501,
      error: "COMPATIBILITY_NOT_IMPLEMENTED",
      reason: "ACHIEVEMENT_OVERLAYS_UNAVAILABLE",
    });
  }
});

test("the declared body is enforced", async () => {
  const server = app(new AchievementOverlaysStore(dataset()));
  const hundred = Array.from({ length: 100 }, () => quiet);
  assert.equal((await post(server, { ids: hundred })).statusCode, 201);
  for (const [label, payload] of [
    ["no ids", {}],
    ["empty ids", { ids: [] }],
    ["101 ids", { ids: [...hundred, quiet] }],
    ["ids object", { ids: { 0: quiet } }],
    ["ids string", { ids: quiet }],
    ["numeric id", { ids: [5] }],
    ["null id", { ids: [null] }],
    ["unknown key", { ids: [quiet], fresh: true }],
    ["array body", [quiet]],
    ["null body", null],
    ["neither format", { ids: ["alice"] }],
    ["base58 with 0", { ids: ["0".repeat(32)] }],
    ["base58 too short", { ids: ["1".repeat(31)] }],
    ["base58 too long", { ids: ["1".repeat(45)] }],
    ["evm too short", { ids: ["0x" + "a".repeat(39)] }],
    // Hex with a 0, so it is not also base58.
    ["evm without 0x", { ids: ["ab01".repeat(10)] }],
    ["evm with non-hex", { ids: ["0x" + "g".repeat(40)] }],
    ["uuid without dashes", { ids: [userId.replaceAll("-", "")] }],
    ["over 64 chars", { ids: ["x".repeat(65)] }],
    ["padded id", { ids: [` ${quiet}`] }],
  ] as [string, unknown][]) {
    const res = await post(server, payload);
    assert.equal(res.statusCode, 400, label);
    assert.deepEqual(res.json(), { statusCode: 400, error: "INVALID_BODY" }, label);
  }
});

test("the operation declares no query parameters", async () => {
  const server = app(new AchievementOverlaysStore(dataset()));
  for (const query of ["?limit=1", "?ids=x", "?", "?=", "?a"]) {
    const res = await post(server, { ids: [quiet] }, query);
    const expected = query === "?" ? 201 : 400;
    assert.equal(res.statusCode, expected, query);
    if (expected === 400) assert.deepEqual(res.json(), { statusCode: 400, error: "INVALID_QUERY" }, query);
  }
});

test("the developer API-key gate still runs first", async () => {
  const res = await app(new AchievementOverlaysStore(dataset())).inject({
    method: "POST",
    url: "/v1/achievements/overlays",
    payload: { ids: [quiet] },
  });
  assert.equal(res.statusCode, 401);
});

test("without a store the documented route keeps its 501", async () => {
  // Fixture replay covers GET and HEAD only, so this POST had no replay path.
  const res = await post(app(), { ids: [quiet] });
  assert.equal(res.statusCode, 501);
  assert.equal(res.json().error, "COMPATIBILITY_NOT_IMPLEMENTED");
  assert.equal(res.json().reason, undefined);
  assert.equal(res.headers["x-reconstruction-data-source"], undefined);
});

test("malformed datasets fail at construction", () => {
  const mutations: [string, (d: any) => void][] = [
    ["extra root key", (d) => { d.extra = 1; }],
    ["version", (d) => { d.schemaVersion = 2; }],
    ["source", (d) => { d.dataSource = "live"; }],
    ["non-canonical observedAt", (d) => { d.observedAt = "2026-10-29T00:00:00Z"; }],
    ["impossible observedAt", (d) => { d.observedAt = "2026-02-30T00:00:00.000Z"; }],
    ["overlays array", (d) => { d.overlays = []; }],
    ["id of neither format", (d) => { d.overlays.alice = []; }],
    ["padded id", (d) => { d.overlays[` ${quiet}`] = []; }],
    ["badges object", (d) => { d.overlays[quiet] = {}; }],
    ["numeric badge", (d) => { d.overlays[quiet] = [1]; }],
    ["empty badge", (d) => { d.overlays[quiet] = [""]; }],
    ["badge over 64 chars", (d) => { d.overlays[quiet] = ["b".repeat(65)]; }],
    ["control character badge", (d) => { d.overlays[quiet] = ["a\nb"]; }],
    ["duplicate badge", (d) => { d.overlays[evm] = ["first-call", "first-call"]; }],
    ["too many badges", (d) => { d.overlays[quiet] = Array.from({ length: 101 }, (_, i) => `b${i}`); }],
    ["hole in badges", (d) => { d.overlays[quiet] = ["a", , "c"]; }],
  ];
  assert.doesNotThrow(() => new AchievementOverlaysStore(dataset()));
  for (const [label, mutate] of mutations) {
    const d = structuredClone(dataset()) as any;
    mutate(d);
    assert.throws(() => new AchievementOverlaysStore(d), TypeError, label);
  }
  const limit = dataset();
  limit.overlays[quiet] = Array.from({ length: 100 }, (_, i) => `b${i}`);
  limit.overlays[evm] = ["c".repeat(64)];
  assert.doesNotThrow(() => new AchievementOverlaysStore(limit));
});

test("the store owns its data against input and response mutation", () => {
  const d = dataset();
  const store = new AchievementOverlaysStore(d);
  d.overlays[solana].reverse();
  d.overlays[quiet].push("late");
  const first = store.overlays([solana, quiet]);
  first[solana].pop();
  first[quiet].push("mutated");
  const second = store.overlays([solana, quiet]);
  assert.deepEqual(second[solana], ["multiple-100x", "weekly-podium", "first-call"]);
  assert.deepEqual(second[quiet], []);
});

test("the startup loader reads only a bounded regular file", () => {
  const dir = mkdtempSync(join(tmpdir(), "achievement-overlays-"));
  try {
    const file = join(dir, "overlays.json");
    writeFileSync(file, JSON.stringify(dataset()));
    assert.equal(loadAchievementOverlaysStore(undefined), undefined);
    assert.deepEqual(loadAchievementOverlaysStore(file)!.overlays([evm]), { [evm]: ["first-call"] });
    const link = join(dir, "link.json");
    symlinkSync(file, link);
    assert.throws(() => loadAchievementOverlaysStore(link));
    // Where O_NOFOLLOW is unavailable (Windows), the symlink is still refused.
    assert.throws(() => loadAchievementOverlaysStore(link, 0), /file type/);
    assert.throws(() => loadAchievementOverlaysStore(dir, 0), /file type/);
    assert.ok(loadAchievementOverlaysStore(file, 0));
    writeFileSync(file, Buffer.from([0x7b, 0xff, 0x7d]));
    assert.throws(() => loadAchievementOverlaysStore(file), TypeError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
