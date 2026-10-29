import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildApp, type Fixture } from "../src/app.js";
import {
  GroupsStore,
  loadGroupsStore,
  UnavailableGroupPnlWindowError,
  UnavailableInvitedViewError,
  UnknownGroupError,
  type GroupMemberFact,
  type GroupsDataset,
} from "../src/groups-store.js";
import { assertSchema } from "../src/schema-validator.js";

const now = "2026-10-29T00:00:00.000Z";
const nowMs = Date.parse(now);
// Synthetic shape-only credential for in-process compatibility-gate tests.
const headers = { authorization: `Bearer pf_live_${"a".repeat(49)}` };
const spec = JSON.parse(
  readFileSync(new URL("../../../contracts/developer.openapi.json", import.meta.url), "utf8"),
);
const okSchema = (path: string) =>
  spec.paths[path].get.responses["200"].content["application/json"].schema;

function profile(userId: string, walletAddress: string | null = `${userId}-wallet`) {
  return {
    userId,
    username: `${userId}-name`,
    bio: "",
    profileImageUrl: "",
    headerImageUrl: "",
    followerCount: 0,
    followingCount: 0,
    createdAt: null,
    updatedAt: null,
    walletAddress,
    socials: [],
    isVerified: false,
    verifiedBadgeVisible: false,
    kind: "PERSON",
    memberCount: 0,
    membershipPolicy: null,
    groupBadges: [],
    generatedMedia: null,
  };
}
function member(
  userId: string | null,
  role: GroupMemberFact["role"] = "MEMBER",
  status: GroupMemberFact["status"] = "ACTIVE",
): GroupMemberFact {
  return {
    profile: userId === null ? null : profile(userId),
    role,
    status,
    invitedBy: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  };
}
function dataset(): GroupsDataset {
  return {
    schemaVersion: 1,
    dataSource: "synthetic",
    observedAt: now,
    pnlWindows: { "1d": { windowStartSec: nowMs / 1000 - 86_400 } },
    groups: [
      {
        groupId: "synthetic-squad",
        // The owner is deliberately not supplied first.
        members: [member("m-b"), member("m-a", "ADMIN"), member("owner", "OWNER"), member(null)],
        pnlFolds: {
          "1d": {
            builtAtMs: nowMs - 60_000,
            rows: [
              { userId: "m-b", walletAddress: "m-b-wallet", pnlUsd: 5 },
              { userId: "owner", walletAddress: "owner-wallet", pnlUsd: 12.5 },
              { userId: "m-a", walletAddress: "m-a-wallet", pnlUsd: 5 },
            ],
          },
        },
      },
      {
        groupId: "synthetic-invites",
        members: [member("owner-2", "OWNER"), member("invitee", "MEMBER", "INVITED")],
        pnlFolds: {},
      },
    ],
  };
}
const app = (store?: GroupsStore, fixtures: Fixture[] = []) =>
  buildApp(fixtures, store ? { groupsStore: store } : {});
const get = (a: ReturnType<typeof app>, url: string) => a.inject({ method: "GET", url, headers });

test("the declared groups contract text is the pinned captured range", () => {
  // Read and hash only; captured code is never imported or executed.
  const source = readFileSync(
    new URL("../../../evidence/web/objects/2b47dd0b38a1608f.js", import.meta.url),
    "utf8",
  );
  const declared = source.slice(221848, 226482);
  assert.equal(
    createHash("sha256").update(declared).digest("hex"),
    "f868abde4e8b2b3e762b230a2c129182778e78a23e390def0f746e8b731eec1c",
  );
  for (const phrase of [
    "A page of a group's members, owner first (the INVITED view is owner/admin-only)",
    "the last published board is served for up to 15 minutes",
    "0 when no fold is published",
    "pnlUsd descending",
  ])
    assert.ok(declared.includes(phrase), phrase);
});

test("members serve owner first, then supplied order, schema-checked with provenance headers", async () => {
  const a = app(new GroupsStore(dataset()));
  const res = await get(a, "/v1/groups/synthetic-squad/members");
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assertSchema(body, okSchema("/groups/{groupId}/members"), "members", spec);
  assert.deepEqual(
    body.members.map((m: GroupMemberFact) => m.profile?.userId ?? null),
    ["owner", "m-b", "m-a", null],
  );
  assert.equal(body.hasMore, false);
  assert.equal(res.headers["x-reconstruction-data-source"], "synthetic");
  assert.equal(res.headers["x-reconstruction-observed-at"], now);
  assert.equal(res.headers["x-reconstruction-compatibility"], "unqualified");
});

test("members paginate with limit/offset and filter ACTIVE", async () => {
  const a = app(new GroupsStore(dataset()));
  const first = (await get(a, "/v1/groups/synthetic-squad/members?limit=2")).json();
  assert.deepEqual(first.members.map((m: any) => m.profile.userId), ["owner", "m-b"]);
  assert.equal(first.hasMore, true);
  const last = (await get(a, "/v1/groups/synthetic-squad/members?limit=2&offset=2")).json();
  assert.equal(last.members.length, 2);
  assert.equal(last.hasMore, false);
  const far = (await get(a, `/v1/groups/synthetic-squad/members?offset=${Number.MAX_SAFE_INTEGER}`)).json();
  assert.deepEqual(far, { members: [], hasMore: false });
  const invites = (await get(a, "/v1/groups/synthetic-invites/members?status=ACTIVE")).json();
  assert.deepEqual(invites.members.map((m: any) => m.profile.userId), ["owner-2"]);
});

test("the owner/admin-only INVITED view fails closed without a viewer", async () => {
  const a = app(new GroupsStore(dataset()));
  for (const url of [
    "/v1/groups/synthetic-invites/members?status=INVITED",
    "/v1/groups/synthetic-invites/members",
    "/v1/groups/synthetic-squad/members?status=INVITED",
  ]) {
    const res = await get(a, url);
    assert.equal(res.statusCode, 501, url);
    assert.equal(res.json().reason, "INVITED_VIEW_REQUIRES_GROUP_ROLE");
  }
  assert.throws(
    () => new GroupsStore(dataset()).members("synthetic-invites"),
    UnavailableInvitedViewError,
  );
});

test("strict queries reject unknown, repeated and non-canonical values", async () => {
  const a = app(new GroupsStore(dataset()));
  for (const query of [
    "limit=0", "limit=201", "limit=1.5", "limit=abc", "limit=", "limit=01", "offset=-1",
    "status=active", "status=UNSPECIFIED", "limit=1&limit=2", "cursor=x",
  ]) {
    const res = await get(a, `/v1/groups/synthetic-squad/members?${query}`);
    assert.equal(res.statusCode, 400, query);
    assert.deepEqual(res.json(), { statusCode: 400, error: "INVALID_QUERY" });
  }
  for (const query of ["", "period=1y", "period=1d&period=1d", "period=1d&sort=x"]) {
    const res = await get(a, `/v1/groups/synthetic-squad/members/pnl?${query}`);
    assert.equal(res.statusCode, 400, query);
  }
});

test("unknown groups are a local 404", async () => {
  const a = app(new GroupsStore(dataset()));
  for (const url of ["/v1/groups/missing/members", "/v1/groups/missing/members/pnl?period=1d"]) {
    const res = await get(a, url);
    assert.equal(res.statusCode, 404, url);
    assert.deepEqual(res.json(), { statusCode: 404, error: "GROUP_NOT_FOUND" });
  }
  assert.throws(() => new GroupsStore(dataset()).membersPnl("missing", "1d"), UnknownGroupError);
});

test("member PnL ranks descending with a local userId tie order", async () => {
  const a = app(new GroupsStore(dataset()));
  const res = await get(a, "/v1/groups/synthetic-squad/members/pnl?period=1d");
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assertSchema(body, okSchema("/groups/{groupId}/members/pnl"), "pnl", spec);
  assert.deepEqual(body, {
    period: "1d",
    builtAtMs: nowMs - 60_000,
    windowStartSec: nowMs / 1000 - 86_400,
    rows: [
      { userId: "owner", walletAddress: "owner-wallet", pnlUsd: 12.5 },
      { userId: "m-a", walletAddress: "m-a-wallet", pnlUsd: 5 },
      { userId: "m-b", walletAddress: "m-b-wallet", pnlUsd: 5 },
    ],
  });
});

test("an unpublished or older-than-15-minute fold serves empty rows with builtAtMs 0", async () => {
  const empty = (await get(app(new GroupsStore(dataset())), "/v1/groups/synthetic-invites/members/pnl?period=1d")).json();
  assert.deepEqual(empty, { period: "1d", builtAtMs: 0, windowStartSec: nowMs / 1000 - 86_400, rows: [] });

  const edge = dataset();
  edge.groups[0].pnlFolds["1d"]!.builtAtMs = nowMs - 15 * 60_000;
  assert.equal(new GroupsStore(edge).membersPnl("synthetic-squad", "1d").rows.length, 3);
  const stale = dataset();
  stale.groups[0].pnlFolds["1d"]!.builtAtMs = nowMs - 15 * 60_000 - 1;
  assert.deepEqual(new GroupsStore(stale).membersPnl("synthetic-squad", "1d").rows, []);
  assert.equal(new GroupsStore(stale).membersPnl("synthetic-squad", "1d").builtAtMs, 0);
});

test("a period without a supplied window is 501, never a guessed window", async () => {
  const res = await get(app(new GroupsStore(dataset())), "/v1/groups/synthetic-squad/members/pnl?period=1w");
  assert.equal(res.statusCode, 501);
  assert.equal(res.json().reason, "GROUP_PNL_WINDOW_UNAVAILABLE");
  assert.throws(
    () => new GroupsStore(dataset()).membersPnl("synthetic-squad", "1m"),
    UnavailableGroupPnlWindowError,
  );
});

test("the developer API-key gate still runs first", async () => {
  const a = app(new GroupsStore(dataset()));
  const res = await a.inject({ method: "GET", url: "/v1/groups/synthetic-squad/members" });
  assert.equal(res.statusCode, 401);
});

test("without a store the documented routes keep fixture replay or 501", async () => {
  const fixture: Fixture = {
    method: "GET",
    path: "/v1/groups/synthetic-squad/members",
    status: 200,
    body: { members: [], hasMore: false },
    source: "synthetic test fixture",
  };
  assert.equal((await get(app(), "/v1/groups/synthetic-squad/members")).statusCode, 501);
  assert.equal((await get(app(), "/v1/groups/synthetic-squad/members/pnl?period=1d")).statusCode, 501);
  const replay = await get(app(undefined, [fixture]), "/v1/groups/synthetic-squad/members");
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.headers["x-reconstruction-data-source"], undefined);
  // A native store wins over a fixture for the same route.
  const native = await get(app(new GroupsStore(dataset()), [fixture]), "/v1/groups/synthetic-squad/members");
  assert.equal(native.json().members.length, 4);
});

test("malformed datasets fail at construction", () => {
  const cases: [string, (d: any) => void][] = [
    ["unknown role", (d) => { d.groups[0].members[0].role = "MODERATOR"; }],
    ["unknown status", (d) => { d.groups[0].members[0].status = "LEFT"; }],
    ["two owners", (d) => { d.groups[0].members[0].role = "OWNER"; }],
    ["invited owner", (d) => { d.groups[1].members[0].status = "INVITED"; }],
    ["duplicate member", (d) => { d.groups[0].members.push(member("m-b")); }],
    ["duplicate group", (d) => { d.groups.push(structuredClone(d.groups[1])); }],
    ["extra profile key", (d) => { d.groups[0].members[0].profile.extra = 1; }],
    ["bad profile kind", (d) => { d.groups[0].members[0].profile.kind = "BOT"; }],
    ["future createdAt", (d) => { d.groups[0].members[0].createdAt = "2026-10-29T00:00:00.001Z"; }],
    ["non-canonical createdAt", (d) => { d.groups[0].members[0].createdAt = "2026-10-01"; }],
    // Shaped like toISOString output; Date.parse silently rolls it over to the next day.
    ["rolled-over createdAt", (d) => { d.groups[0].members[0].createdAt = "2026-09-30T24:00:00.000Z"; }],
    ["extra member key", (d) => { d.groups[0].members[0].inCompetition = true; }],
    ["row for non-member", (d) => { d.groups[0].pnlFolds["1d"].rows[0].userId = "stranger"; }],
    ["row for invited member", (d) => {
      d.groups[1].pnlFolds = { "1d": { builtAtMs: nowMs, rows: [{ userId: "invitee", walletAddress: "invitee-wallet", pnlUsd: 1 }] } };
    }],
    ["row wallet mismatch", (d) => { d.groups[0].pnlFolds["1d"].rows[0].walletAddress = "other"; }],
    ["duplicate row", (d) => { d.groups[0].pnlFolds["1d"].rows.push({ userId: "m-b", walletAddress: "m-b-wallet", pnlUsd: 1 }); }],
    ["non-finite pnl", (d) => { d.groups[0].pnlFolds["1d"].rows[0].pnlUsd = Number.NaN; }],
    ["future fold", (d) => { d.groups[0].pnlFolds["1d"].builtAtMs = nowMs + 1; }],
    ["fold before window", (d) => { d.groups[0].pnlFolds["1d"].builtAtMs = (nowMs / 1000 - 86_401) * 1000; }],
    ["fold without window", (d) => { d.groups[0].pnlFolds["1w"] = { builtAtMs: nowMs, rows: [] }; }],
    ["unknown period", (d) => { d.pnlWindows["1y"] = { windowStartSec: 0 }; }],
    ["future window", (d) => { d.pnlWindows["1d"].windowStartSec = nowMs / 1000 + 1; }],
    ["bad source", (d) => { d.dataSource = "upstream"; }],
    ["extra root key", (d) => { d.extra = true; }],
  ];
  for (const [label, mutate] of cases) {
    const d = dataset();
    mutate(d);
    assert.throws(() => new GroupsStore(d), TypeError, label);
  }
});

test("the store owns its data against input and response mutation", async () => {
  const d = dataset();
  const store = new GroupsStore(d);
  (d.groups[0].members[2].profile as any).username = "mutated";
  d.groups[0].pnlFolds["1d"]!.rows[0].pnlUsd = 999;
  const page = store.members("synthetic-squad");
  (page.members[0].profile as any).username = "mutated";
  store.membersPnl("synthetic-squad", "1d").rows[0].pnlUsd = 999;
  assert.equal(store.members("synthetic-squad").members[0].profile?.username, "owner-name");
  assert.equal(store.membersPnl("synthetic-squad", "1d").rows[0].pnlUsd, 12.5);
});

test("the startup loader reads only a bounded regular file", () => {
  const dir = mkdtempSync(join(tmpdir(), "groups-"));
  try {
    const file = join(dir, "groups.json");
    writeFileSync(file, JSON.stringify(dataset()));
    assert.equal(loadGroupsStore(undefined), undefined);
    assert.equal(loadGroupsStore(file)!.members("synthetic-squad").members.length, 4);
    const link = join(dir, "link.json");
    symlinkSync(file, link);
    assert.throws(() => loadGroupsStore(link));
    // Where O_NOFOLLOW is unavailable (Windows), the symlink is still refused.
    assert.throws(() => loadGroupsStore(link, 0), /file type/);
    assert.throws(() => loadGroupsStore(dir, 0), /file type/);
    assert.ok(loadGroupsStore(file, 0));
    writeFileSync(file, Buffer.from([0x7b, 0xff, 0x7d]));
    assert.throws(() => loadGroupsStore(file), TypeError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
