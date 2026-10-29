import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildApp } from "../src/app.js";
import {
  GeneratedMediaStore,
  loadGeneratedMediaStore,
  type GeneratedMediaDataset,
} from "../src/generated-media-store.js";
import { assertSchema } from "../src/schema-validator.js";

const now = "2026-10-29T00:00:00.000Z";
// Synthetic shape-only credential for in-process compatibility-gate tests.
const headers = { authorization: `Bearer pf_live_${"a".repeat(49)}` };
const spec = JSON.parse(
  readFileSync(new URL("../../../contracts/developer.openapi.json", import.meta.url), "utf8"),
);
const okSchema =
  spec.paths["/profiles/generated-media"].post.responses["201"].content["application/json"].schema;
const solana = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const evm = "0x" + "aB".repeat(20);
const userId = "0b5f3c1e-8d2a-4f6b-9c7e-1a2b3c4d5e6f";
const nobody = "11111111111111111111111111111111";

function dataset(): GeneratedMediaDataset {
  return {
    schemaVersion: 1,
    dataSource: "synthetic",
    observedAt: now,
    entries: {
      [solana]: {
        isVerified: true,
        verifiedBadgeVisible: true,
        pnlLoop: { uid: "loop-1", durationSeconds: 6.5 },
        replayIntro: { uid: "intro-1", durationSeconds: 2, fireAt: 0 },
      },
      [evm]: { isVerified: true, verifiedBadgeVisible: false, pnlLoop: { uid: "loop-2", durationSeconds: 4 } },
      [userId]: { isVerified: false, verifiedBadgeVisible: true },
      // An id with no user: not verified, badge hint true, no media.
      [nobody]: { isVerified: false, verifiedBadgeVisible: true },
    },
  };
}
function app(store?: GeneratedMediaStore) {
  return buildApp([], store ? { generatedMediaStore: store } : {});
}
function post(server: ReturnType<typeof buildApp>, payload: unknown, query = "") {
  return server.inject({ method: "POST", url: `/v1/profiles/generated-media${query}`, headers, payload: payload as any });
}

test("the declared contract text is the pinned captured ranges", () => {
  // Read and hash only; captured code is never imported or executed.
  const source = readFileSync(
    new URL("../../../evidence/web/objects/2b47dd0b38a1608f.js", import.meta.url),
    "utf8",
  );
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const route = source.slice(345374, 346645);
  assert.equal(hash(route), "4d1807e87a7f5886eb67c582bc289ec0f290f0963a46befbb26f137d5a1b0302");
  for (const phrase of [
    "i=o.z.object({ids:o.z.array(o.z.string().max(64)).min(1).max(200)",
    "Wallet addresses (Solana base58 or EVM 0x) or user ids (UUID), disambiguated by format.",
    '"POST /profiles/generated-media":(0,s.publicRead)("profiles.read",{summary:"Verified badge plus generated share media',
    "body:i,response:o.z.record(o.z.string(),o.z.object({isVerified:o.z.boolean()",
    "show the checkmark only when both are true; true for ids with no user",
    "Owner-only: present on the authenticated caller's own entry when it carries media",
    "Absent on every other entry.",
    ".extend(a.normalizedGeneratedMedia.partial().shape)",
  ])
    assert.ok(route.includes(phrase), phrase);
  const media = source.slice(487196, 487407);
  assert.equal(hash(media), "5d0ea3d7cbb78e3a36ba091ba2cdc4eae50135193ed38258b59858b395f20a93");
  assert.equal(
    media,
    "r.normalizedGeneratedMedia=o.z.object({pnlLoop:o.z.object({uid:o.z.string(),durationSeconds:o.z.number()})," +
      "replayIntro:o.z.object({uid:o.z.string(),durationSeconds:o.z.number(),fireAt:o.z.number()}).optional()})",
  );
});

test("supplied entries are served as a 201 map without the owner-only flag", async () => {
  const res = await post(app(new GeneratedMediaStore(dataset())), { ids: [userId, solana, evm, nobody] });
  assert.equal(res.statusCode, 201);
  assert.equal(res.headers["x-reconstruction-data-source"], "synthetic");
  assert.equal(res.headers["x-reconstruction-observed-at"], now);
  assert.equal(res.headers["x-reconstruction-compatibility"], "unqualified");
  const body = res.json();
  assertSchema(body, okSchema, "generated media", spec);
  const expected = dataset().entries;
  assert.deepEqual(body, {
    [userId]: expected[userId],
    [solana]: expected[solana],
    [evm]: expected[evm],
    [nobody]: expected[nobody],
  });
  assert.deepEqual(Object.keys(body), [userId, solana, evm, nobody]);
  for (const entry of Object.values(body) as any[]) assert.ok(!("unseen" in entry));
  // Absent media stays absent rather than null.
  assert.deepEqual(Object.keys(body[userId]), ["isVerified", "verifiedBadgeVisible"]);
  assert.deepEqual(Object.keys(body[evm]), ["isVerified", "verifiedBadgeVisible", "pnlLoop"]);
});

test("a repeated id is served once", async () => {
  const res = await post(app(new GeneratedMediaStore(dataset())), { ids: [evm, evm, nobody] });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(Object.keys(res.json()), [evm, nobody]);
});

test("any unsupplied id makes the whole batch a 501", async () => {
  const server = app(new GeneratedMediaStore(dataset()));
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
      reason: "GENERATED_MEDIA_UNAVAILABLE",
    });
  }
});

test("the declared body is enforced", async () => {
  const server = app(new GeneratedMediaStore(dataset()));
  const max = Array.from({ length: 200 }, () => nobody);
  assert.equal((await post(server, { ids: max })).statusCode, 201);
  for (const [label, payload] of [
    ["no ids", {}],
    ["empty ids", { ids: [] }],
    ["201 ids", { ids: [...max, nobody] }],
    ["ids object", { ids: { 0: nobody } }],
    ["ids string", { ids: nobody }],
    ["numeric id", { ids: [5] }],
    ["null id", { ids: [null] }],
    ["unknown key", { ids: [nobody], viewer: solana }],
    ["array body", [nobody]],
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
    ["padded id", { ids: [` ${nobody}`] }],
  ] as [string, unknown][]) {
    const res = await post(server, payload);
    assert.equal(res.statusCode, 400, label);
    assert.deepEqual(res.json(), { statusCode: 400, error: "INVALID_BODY" }, label);
  }
});

test("the operation declares no query parameters", async () => {
  const server = app(new GeneratedMediaStore(dataset()));
  for (const query of ["?viewer=x", "?ids=x", "?", "?=", "?a"]) {
    const res = await post(server, { ids: [nobody] }, query);
    const expected = query === "?" ? 201 : 400;
    assert.equal(res.statusCode, expected, query);
    if (expected === 400) assert.deepEqual(res.json(), { statusCode: 400, error: "INVALID_QUERY" }, query);
  }
});

test("the developer API-key gate still runs first", async () => {
  const res = await app(new GeneratedMediaStore(dataset())).inject({
    method: "POST",
    url: "/v1/profiles/generated-media",
    payload: { ids: [nobody] },
  });
  assert.equal(res.statusCode, 401);
});

test("without a store the documented route keeps its 501 and the sibling verified route is untouched", async () => {
  // Fixture replay covers GET and HEAD only, so this POST had no replay path.
  const res = await post(app(), { ids: [nobody] });
  assert.equal(res.statusCode, 501);
  assert.equal(res.json().error, "COMPATIBILITY_NOT_IMPLEMENTED");
  assert.equal(res.headers["x-reconstruction-data-source"], undefined);
  for (const server of [app(), app(new GeneratedMediaStore(dataset()))]) {
    const verified = await server.inject({ method: "POST", url: "/v1/profiles/verified", headers, payload: { ids: [solana] } });
    assert.equal(verified.statusCode, 201);
    assert.notEqual(verified.headers["x-reconstruction-compatibility"], "unqualified");
  }
});

test("malformed datasets fail at construction", () => {
  const row = (d: any) => d.entries[solana];
  const mutations: [string, (d: any) => void][] = [
    ["extra root key", (d) => { d.extra = 1; }],
    ["version", (d) => { d.schemaVersion = 2; }],
    ["source", (d) => { d.dataSource = "live"; }],
    ["non-canonical observedAt", (d) => { d.observedAt = "2026-10-29T00:00:00Z"; }],
    // Shaped like toISOString output; Date.parse silently rolls it over to the next day.
    ["rolled-over observedAt", (d) => { d.observedAt = "2026-10-28T24:00:00.000Z"; }],
    ["entries array", (d) => { d.entries = []; }],
    ["id of neither format", (d) => { d.entries.alice = { isVerified: false, verifiedBadgeVisible: true }; }],
    ["padded id", (d) => { d.entries[` ${nobody}`] = { isVerified: false, verifiedBadgeVisible: true }; }],
    ["entry array", (d) => { d.entries[nobody] = []; }],
    ["supplied unseen", (d) => { row(d).unseen = true; }],
    ["extra entry key", (d) => { row(d).username = "x"; }],
    ["missing isVerified", (d) => { delete row(d).isVerified; }],
    ["missing badge hint", (d) => { delete row(d).verifiedBadgeVisible; }],
    ["string isVerified", (d) => { row(d).isVerified = "true"; }],
    ["null badge hint", (d) => { row(d).verifiedBadgeVisible = null; }],
    // On a row without an intro, so only the loop check itself can reject it.
    ["null pnlLoop", (d) => { d.entries[evm].pnlLoop = null; }],
    ["false pnlLoop", (d) => { d.entries[evm].pnlLoop = false; }],
    ["extra pnlLoop key", (d) => { row(d).pnlLoop.url = "x"; }],
    ["missing pnlLoop uid", (d) => { delete row(d).pnlLoop.uid; }],
    ["empty pnlLoop uid", (d) => { row(d).pnlLoop.uid = ""; }],
    ["control character uid", (d) => { row(d).pnlLoop.uid = "a\nb"; }],
    ["zero loop duration", (d) => { row(d).pnlLoop.durationSeconds = 0; }],
    ["negative loop duration", (d) => { row(d).pnlLoop.durationSeconds = -1; }],
    ["infinite loop duration", (d) => { row(d).pnlLoop.durationSeconds = Infinity; }],
    ["string loop duration", (d) => { row(d).pnlLoop.durationSeconds = "6"; }],
    ["intro without loop", (d) => { delete row(d).pnlLoop; }],
    ["null replayIntro", (d) => { row(d).replayIntro = null; }],
    ["missing fireAt", (d) => { delete row(d).replayIntro.fireAt; }],
    ["extra intro key", (d) => { row(d).replayIntro.url = "x"; }],
    ["empty intro uid", (d) => { row(d).replayIntro.uid = ""; }],
    ["zero intro duration", (d) => { row(d).replayIntro.durationSeconds = 0; }],
    ["negative fireAt", (d) => { row(d).replayIntro.fireAt = -0.5; }],
    ["NaN fireAt", (d) => { row(d).replayIntro.fireAt = Number.NaN; }],
  ];
  assert.doesNotThrow(() => new GeneratedMediaStore(dataset()));
  for (const [label, mutate] of mutations) {
    const d = structuredClone(dataset()) as any;
    mutate(d);
    assert.throws(() => new GeneratedMediaStore(d), TypeError, label);
  }
});

test("the store owns its data against input and response mutation", () => {
  const d = dataset();
  const store = new GeneratedMediaStore(d);
  d.entries[solana].pnlLoop!.uid = "changed";
  d.entries[solana].replayIntro!.fireAt = 9;
  d.entries[evm].isVerified = false;
  const first = store.entries([solana, evm]);
  first[solana].pnlLoop!.uid = "mutated";
  first[solana].replayIntro!.fireAt = 7;
  first[evm].isVerified = false;
  delete first[evm].pnlLoop;
  const second = store.entries([solana, evm]);
  assert.deepEqual(second[solana], dataset().entries[solana]);
  assert.deepEqual(second[evm], dataset().entries[evm]);
});

test("the startup loader reads only a bounded regular file", () => {
  const dir = mkdtempSync(join(tmpdir(), "generated-media-"));
  try {
    const file = join(dir, "media.json");
    writeFileSync(file, JSON.stringify(dataset()));
    assert.equal(loadGeneratedMediaStore(undefined), undefined);
    assert.deepEqual(loadGeneratedMediaStore(file)!.entries([evm]), { [evm]: dataset().entries[evm] });
    const link = join(dir, "link.json");
    symlinkSync(file, link);
    assert.throws(() => loadGeneratedMediaStore(link));
    // Where O_NOFOLLOW is unavailable (Windows), the symlink is still refused.
    assert.throws(() => loadGeneratedMediaStore(link, 0), /file type/);
    assert.throws(() => loadGeneratedMediaStore(dir, 0), /file type/);
    assert.ok(loadGeneratedMediaStore(file, 0));
    writeFileSync(file, Buffer.from([0x7b, 0xff, 0x7d]));
    assert.throws(() => loadGeneratedMediaStore(file), TypeError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
