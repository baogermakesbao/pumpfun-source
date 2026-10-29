import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildApp, type Fixture } from "../src/app.js";
import {
  MintPositionsStore,
  loadMintPositionsStore,
  type MintHolderFact,
  type MintPositionsDataset,
} from "../src/mint-positions-store.js";
import { assertSchema } from "../src/schema-validator.js";

const now = "2026-10-29T00:00:00.000Z";
// Synthetic shape-only credential for in-process compatibility-gate tests.
const headers = { authorization: `Bearer pf_live_${"a".repeat(49)}` };
const base = "/v1/mint-positions";
const spec = JSON.parse(
  readFileSync(new URL("../../../contracts/developer.openapi.json", import.meta.url), "utf8"),
);
const okSchema =
  spec.paths["/mint-positions/{mint}"].get.responses["200"].content["application/json"].schema;

function update(n: number) {
  return { id: `upd-${n}`, content: `update ${n}`, createdAt: null, likeCount: 0, mediaUrl: null, parentMessageId: null, repostCount: 0 };
}
function callout(id: string, thesis: string | null, updates = 0): Record<string, unknown> {
  return {
    calloutId: id,
    calledOutAtMcap: 50_000,
    multiple: 2,
    thesis,
    mediaUrl: null,
    calloutTimestamp: "2026-10-28T00:00:00.000Z",
    likes: 3,
    hasLiked: null,
    updates: Array.from({ length: updates }, (_, index) => update(index + 1)),
    updateCount: updates,
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
function profile(n: number): Record<string, unknown> {
  return {
    userId: `user-${n}`,
    username: `name-${n}`,
    bio: "",
    profileImageUrl: "",
    headerImageUrl: "",
    followerCount: 0,
    followingCount: 0,
    createdAt: null,
    updatedAt: null,
    walletAddress: `wallet-${n}`,
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
type Thesis = string | null | "none";
function holder(n: number, { thesis = "thesis" as Thesis, held = 10, realized = 0, updates = 0, wallet = true } = {}): MintHolderFact {
  return {
    row: {
      coinMint: "MintA",
      chainId: null,
      userId: wallet ? `user-${n}` : "",
      userName: wallet ? `name-${n}` : "",
      profileImage: null,
      walletAddress: `wallet-${n}`,
      isVerified: false,
      verifiedBadgeVisible: false,
      xUsername: null,
      accountKind: "person",
      amountHeld: held,
      pnlUsd: realized,
      pnlPercentage: null,
      realizedPnlUsd: realized,
      costBasisAmount: held,
      costBasisUsd: null,
      amountBoughtUsd: null,
      amountBought: null,
      callout: thesis === "none" ? null : callout(`callout-${n}`, thesis, updates),
    },
    profile: wallet ? profile(n) : null,
  };
}
function dataset(): MintPositionsDataset {
  return {
    schemaVersion: 1,
    dataSource: "synthetic",
    observedAt: now,
    mints: {
      MintA: {
        open: [
          holder(1, { updates: 7 }),
          holder(2, { thesis: null }),
          holder(3),
          holder(4, { thesis: "none", wallet: false }),
          holder(5, { thesis: "  " }),
        ],
        orders: { TOP: [2, 0, 4, 1, 3], LATEST: [4, 3, 2, 1, 0], LOWEST_ENTRY: [1, 0] },
        closed: [
          holder(11, { held: 0, realized: -5 }),
          holder(12, { held: 0, realized: 40 }),
          holder(13, { held: 0, realized: 90, thesis: "none" }),
          holder(14, { held: 0, realized: 10, thesis: null }),
          holder(15, { held: 0, realized: 0 }),
        ],
      },
      Empty: { open: [], orders: { TOP: [], LATEST: [] }, closed: null },
    },
  };
}
function app(store?: MintPositionsStore, fixtures: Fixture[] = []) {
  return buildApp(fixtures, store ? { mintPositionsStore: store } : {});
}
function get(server: ReturnType<typeof buildApp>, mint: string, query = "") {
  return server.inject({ method: "GET", url: `${base}/${mint}${query}`, headers });
}
const wallets = (body: any) => body.positions.map((row: any) => row.walletAddress);

test("the declared contract text is the pinned captured range", () => {
  // Read and hash only; captured code is never imported or executed.
  const source = readFileSync(
    new URL("../../../evidence/web/objects/2b47dd0b38a1608f.js", import.meta.url),
    "utf8",
  );
  const route = source.slice(273021, 278872);
  const row = source.slice(471229, 475412);
  assert.equal(createHash("sha256").update(route).digest("hex"), "48e75fa2f3e8a7d7482cf3f37e27bbdb7248e1cd6baf23400b95bb4c07a0c96b");
  assert.equal(createHash("sha256").update(row).digest("hex"), "314628be8a9cc85ba474677fdbeb14901adce1d2d3b56878ace0114083b164de");
  for (const phrase of [
    "ranked by realized PnL USD descending, losses last, and requires withThesis=true",
    "cc applies it before paging",
    "omitted serves 5); 0 skips update enrichment entirely",
    "rejected with sortBy=CLOSED_PNL",
    "LATEST/TOP/LOWEST_ENTRY count the mint's open holders",
    "counts the closed holders that have a callout for this mint",
    "derive it from totalCount",
    "Always false on an empty page",
    "pageSize:o.z.number().int().min(1).max(50)",
  ])
    assert.ok(route.includes(phrase), phrase);
  assert.ok(row.includes("keyed (wallet, mint, chain)"));
  assert.ok(row.includes("Present only when includeProfile=true"));
});

test("an open sort serves its supplied order with an offset page", async () => {
  const server = app(new MintPositionsStore(dataset()));
  const res = await get(server, "MintA", "?sortBy=TOP");
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-reconstruction-data-source"], "synthetic");
  assert.equal(res.headers["x-reconstruction-observed-at"], now);
  assert.equal(res.headers["x-reconstruction-compatibility"], "unqualified");
  const body = res.json();
  assertSchema(body, okSchema, "TOP", spec);
  assert.deepEqual(wallets(body), ["wallet-3", "wallet-1", "wallet-5", "wallet-2", "wallet-4"]);
  assert.deepEqual([body.totalCount, body.hasMore], [5, false]);
  for (const key of ["profile", "coins", "nextPageToken", "recommendationId"])
    assert.equal(Object.hasOwn(body.positions[0], key) || Object.hasOwn(body, key), false, key);

  const first = (await get(server, "MintA", "?sortBy=TOP&pageSize=2")).json();
  assert.deepEqual([wallets(first), first.hasMore], [["wallet-3", "wallet-1"], true]);
  const last = (await get(server, "MintA", "?sortBy=TOP&pageSize=2&page=2")).json();
  assert.deepEqual([wallets(last), last.hasMore, last.totalCount], [["wallet-4"], false, 5]);
  const beyond = (await get(server, "MintA", "?sortBy=TOP&pageSize=2&page=9")).json();
  assert.deepEqual([beyond.positions, beyond.hasMore, beyond.totalCount], [[], false, 5]);
});

test("pageSize defaults to the declared ceiling of 50", async () => {
  const d = dataset();
  d.mints.Many = {
    open: Array.from({ length: 60 }, (_, index) => {
      const fact = holder(100 + index);
      fact.row.coinMint = "Many";
      return fact;
    }),
    orders: { TOP: Array.from({ length: 60 }, (_, index) => index) },
    closed: null,
  };
  const server = app(new MintPositionsStore(d));
  const first = (await get(server, "Many", "?sortBy=TOP")).json();
  assertSchema(first, okSchema, "Many", spec);
  assert.deepEqual([first.positions.length, first.totalCount, first.hasMore], [50, 60, true]);
  const second = (await get(server, "Many", "?sortBy=TOP&page=1")).json();
  assert.deepEqual([second.positions.length, second.hasMore], [10, false]);
  assert.equal(second.positions[0].walletAddress, "wallet-150");
});

test("each open sort uses its own order and counts every open holder", async () => {
  const server = app(new MintPositionsStore(dataset()));
  const latest = (await get(server, "MintA", "?sortBy=LATEST")).json();
  assert.deepEqual(wallets(latest), ["wallet-5", "wallet-4", "wallet-3", "wallet-2", "wallet-1"]);
  const lowest = (await get(server, "MintA", "?sortBy=LOWEST_ENTRY")).json();
  assertSchema(lowest, okSchema, "LOWEST_ENTRY", spec);
  assert.deepEqual([wallets(lowest), lowest.totalCount], [["wallet-2", "wallet-1"], 5]);
});

test("the thesis filter runs before paging; hasMore still derives from totalCount", async () => {
  const server = app(new MintPositionsStore(dataset()));
  const all = (await get(server, "MintA", "?sortBy=TOP&withThesis=true")).json();
  assert.deepEqual([wallets(all), all.totalCount], [["wallet-3", "wallet-1"], 5]);
  const first = (await get(server, "MintA", "?sortBy=TOP&withThesis=true&pageSize=2")).json();
  // The last non-empty filtered page may still report more, as declared.
  assert.deepEqual([wallets(first), first.hasMore], [["wallet-3", "wallet-1"], true]);
  const next = (await get(server, "MintA", "?sortBy=TOP&withThesis=true&pageSize=2&page=1")).json();
  assert.deepEqual([next.positions, next.hasMore], [[], false]);
  const off = (await get(server, "MintA", "?sortBy=TOP&withThesis=false")).json();
  assert.equal(off.positions.length, 5);
});

test("CLOSED_PNL ranks exited thesis holders by realized PnL, losses last", async () => {
  const server = app(new MintPositionsStore(dataset()));
  const body = (await get(server, "MintA", "?sortBy=CLOSED_PNL&withThesis=true")).json();
  assertSchema(body, okSchema, "CLOSED_PNL", spec);
  assert.deepEqual(wallets(body), ["wallet-12", "wallet-15", "wallet-11"]);
  assert.deepEqual(body.positions.map((row: any) => row.realizedPnlUsd), [40, 0, -5]);
  // Closed holders with a callout, thesis or not.
  assert.equal(body.totalCount, 4);
  for (const query of ["?sortBy=CLOSED_PNL", "?sortBy=CLOSED_PNL&withThesis=false"])
    assert.equal((await get(server, "MintA", query)).statusCode, 400, query);
});

test("updatesLimit truncates author updates, 5 by default, 0 for none", async () => {
  const server = app(new MintPositionsStore(dataset()));
  const pick = async (query: string) =>
    (await get(server, "MintA", `?sortBy=TOP${query}`)).json().positions.find((row: any) => row.walletAddress === "wallet-1").callout;
  assert.deepEqual((await pick("")).updates.map((u: any) => u.id), ["upd-1", "upd-2", "upd-3", "upd-4", "upd-5"]);
  assert.deepEqual((await pick("&updatesLimit=2")).updates.map((u: any) => u.id), ["upd-1", "upd-2"]);
  assert.deepEqual((await pick("&updatesLimit=20")).updates.length, 7);
  const none = await pick("&updatesLimit=0");
  assert.deepEqual([none.updates, none.updateCount], [[], 7]);
});

test("includeProfile embeds the registry profile, null for wallet-only holders", async () => {
  const server = app(new MintPositionsStore(dataset()));
  const body = (await get(server, "MintA", "?sortBy=LATEST&includeProfile=true")).json();
  assertSchema(body, okSchema, "profiles", spec);
  const byWallet = Object.fromEntries(body.positions.map((row: any) => [row.walletAddress, row]));
  assert.equal(byWallet["wallet-1"].profile.username, "name-1");
  assert.equal(byWallet["wallet-4"].profile, null);
  assert.equal(byWallet["wallet-4"].userId, "");
  const off = (await get(server, "MintA", "?sortBy=LATEST&includeProfile=false")).json();
  assert.ok(off.positions.every((row: any) => !Object.hasOwn(row, "profile")));
});

test("an empty supplied mint is an empty page", async () => {
  const body = (await get(app(new MintPositionsStore(dataset())), "Empty", "?sortBy=TOP")).json();
  assertSchema(body, okSchema, "empty", spec);
  assert.deepEqual(body, { positions: [], totalCount: 0, hasMore: false });
});

test("unimplemented capabilities are a 501 with a reason, never a guess", async () => {
  const server = app(new MintPositionsStore(dataset()));
  const cases: [string, string, string][] = [
    ["MintA", "?sortBy=RANKED", "RANKED_UNAVAILABLE"],
    ["MintA", "?sortBy=RANKED&session_id=s&chainId=8453", "RANKED_UNAVAILABLE"],
    ["MintA", "?sortBy=TOP&chain=hlcore:mainnet", "CHAIN_UNAVAILABLE"],
    ["MintA", "?sortBy=TOP&withThesis=true&scope=pairs", "PAIRS_SCOPE_UNAVAILABLE"],
    ["MintA", "?sortBy=LOWEST_ENTRY&dustFloorUsd=5", "DUST_FLOOR_UNAVAILABLE"],
    ["MintA", "", "DEFAULT_SORT_UNDECLARED"],
    ["MintA", "?page=0", "DEFAULT_SORT_UNDECLARED"],
    ["Unknown", "?sortBy=TOP", "MINT_POSITIONS_UNAVAILABLE"],
    ["Empty", "?sortBy=LOWEST_ENTRY", "SORT_ORDER_UNAVAILABLE"],
    ["Empty", "?sortBy=CLOSED_PNL&withThesis=true", "CLOSED_POSITIONS_UNAVAILABLE"],
  ];
  for (const [mint, query, reason] of cases) {
    const res = await get(server, mint, query);
    assert.equal(res.statusCode, 501, `${mint}${query}`);
    assert.deepEqual(res.json(), { statusCode: 501, error: "COMPATIBILITY_NOT_IMPLEMENTED", reason }, `${mint}${query}`);
  }
  const scoped = await get(server, "MintA", "?sortBy=TOP&scope=mint");
  assert.equal(scoped.statusCode, 200);
});

test("strict queries reject unknown, repeated and malformed values", async () => {
  const server = app(new MintPositionsStore(dataset()));
  for (const query of [
    "?sortBy=TOP&foo=1",
    "?sortBy=TOP&sortBy=TOP",
    "?sortBy=top",
    "?sortBy=TOP&page=-1",
    "?sortBy=TOP&page=1.5",
    "?sortBy=TOP&page=01",
    "?sortBy=TOP&pageSize=0",
    "?sortBy=TOP&pageSize=51",
    "?sortBy=TOP&updatesLimit=21",
    "?sortBy=TOP&withThesis=1",
    "?sortBy=TOP&includeProfile=yes",
    "?sortBy=TOP&dustFloorUsd=abc",
    "?sortBy=TOP&dustFloorUsd=-1",
    "?sortBy=TOP&dustFloorUsd=100001",
    "?sortBy=CLOSED_PNL&withThesis=true&dustFloorUsd=5",
    "?sortBy=TOP&chain=solana:mainnet",
    "?sortBy=TOP&scope=all",
    "?sortBy=RANKED&pageToken=t&page=0",
    "?sortBy=RANKED&country=x",
    `?sortBy=RANKED&session_id=${"s".repeat(129)}`,
    "?sortBy=RANKED&chainId=0",
    "?sortBy=RANKED&forceRefresh=1",
    "?sortBy=TOP&session_id=s",
    "?sortBy=TOP&chainId=8453",
    "?sortBy=TOP&forceRefresh=true",
    "?sortBy=TOP&pageToken=t",
  ]) {
    const res = await get(server, "MintA", query);
    assert.equal(res.statusCode, 400, query);
    assert.deepEqual(res.json(), { statusCode: 400, error: "INVALID_QUERY" }, query);
  }
});

test("the developer API-key gate still runs first", async () => {
  const res = await app(new MintPositionsStore(dataset())).inject({ method: "GET", url: `${base}/MintA?sortBy=TOP` });
  assert.equal(res.statusCode, 401);
});

test("without a store the documented route keeps fixture replay or 501", async () => {
  const fixture: Fixture = {
    method: "GET",
    path: `${base}/MintA`,
    query: { sortBy: "TOP" },
    status: 200,
    body: { positions: [], totalCount: 0, hasMore: false },
    source: "synthetic test fixture",
  };
  assert.equal((await get(app(), "MintA", "?sortBy=TOP")).statusCode, 501);
  const replay = await get(app(undefined, [fixture]), "MintA", "?sortBy=TOP");
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.headers["x-reconstruction-data-source"], undefined);
  const native = await get(app(new MintPositionsStore(dataset()), [fixture]), "MintA", "?sortBy=TOP");
  assert.equal(native.json().positions.length, 5);
});

test("malformed datasets fail at construction", () => {
  const open = (d: any) => d.mints.MintA.open;
  const mutations: [string, (d: any) => void][] = [
    ["extra root key", (d) => { d.extra = 1; }],
    ["version", (d) => { d.schemaVersion = 2; }],
    ["source", (d) => { d.dataSource = "live"; }],
    ["non-canonical observedAt", (d) => { d.observedAt = "2026-10-29T00:00:00Z"; }],
    // Shaped like toISOString output; Date.parse silently rolls it over to the next day.
    ["rolled-over observedAt", (d) => { d.observedAt = "2026-10-28T24:00:00.000Z"; }],
    ["extra mint key", (d) => { d.mints.MintA.extra = 1; }],
    ["extra holder key", (d) => { open(d)[0].extra = 1; }],
    ["extra row key", (d) => { open(d)[0].row.receiptBasisUsd = 1; }],
    ["missing row key", (d) => { delete open(d)[0].row.pnlUsd; }],
    ["row profile key", (d) => { open(d)[0].row.profile = null; }],
    ["perp chain", (d) => { open(d)[0].row.chain = "hlcore:mainnet"; }],
    ["asset class", (d) => { open(d)[0].row.assetClass = "ASSET_CLASS_TOKEN"; }],
    ["perp block", (d) => { open(d)[0].row.perp = null; }],
    ["ranked fields", (d) => { open(d)[0].row.recommendationRank = 1; }],
    ["other mint", (d) => { open(d)[0].row.coinMint = "MintB"; }],
    ["callout schema", (d) => { delete open(d)[0].row.callout.likes; }],
    ["viewer like", (d) => { open(d)[0].row.callout.hasLiked = true; }],
    ["viewer repost", (d) => { open(d)[0].row.callout.hasReposted = false; }],
    ["too many updates", (d) => {
      open(d)[0].row.callout.updates = Array.from({ length: 21 }, (_, index) => update(index));
    }],
    ["bad profile", (d) => { open(d)[0].profile.kind = "ROBOT"; }],
    ["array profile", (d) => { open(d)[0].profile = []; }],
    ["duplicate holder", (d) => { open(d)[1].row.walletAddress = "wallet-1"; }],
    ["open holder with nothing held", (d) => { open(d)[0].row.amountHeld = 0; }],
    ["closed holder still holding", (d) => { d.mints.MintA.closed[0].row.amountHeld = 1; }],
    ["unknown sort order", (d) => { d.mints.MintA.orders.RANKED = [0]; }],
    ["order out of range", (d) => { d.mints.MintA.orders.LOWEST_ENTRY = [5]; }],
    ["order repeats", (d) => { d.mints.MintA.orders.LOWEST_ENTRY = [0, 0]; }],
    ["TOP misses a holder", (d) => { d.mints.MintA.orders.TOP = [0, 1, 2, 3]; }],
    ["LATEST misses a holder", (d) => { d.mints.MintA.orders.LATEST = [0, 1, 2, 3]; }],
    ["fractional index", (d) => { d.mints.MintA.orders.LOWEST_ENTRY = [0.5]; }],
    ["hole in holders", (d) => { d.mints.MintA.open = [open(d)[0], , open(d)[2]]; }],
  ];
  assert.doesNotThrow(() => new MintPositionsStore(dataset()));
  for (const [label, mutate] of mutations) {
    const d = structuredClone(dataset()) as any;
    mutate(d);
    assert.throws(() => new MintPositionsStore(d), TypeError, label);
  }
});

test("the store owns its data against input and response mutation", () => {
  const d = dataset();
  const store = new MintPositionsStore(d);
  d.mints.MintA.open[2].row.walletAddress = "changed";
  (d.mints.MintA.open[2].row.callout as any).thesis = "changed";
  d.mints.MintA.orders.TOP!.reverse();
  d.mints.MintA.open[2].profile!.username = "changed";
  const first = store.page("MintA", { sortBy: "TOP", includeProfile: true });
  first.positions[0].walletAddress = "mutated";
  (first.positions[0].callout as any).updates.push(update(99));
  (first.positions[0].profile as any).username = "mutated";
  const second = store.page("MintA", { sortBy: "TOP", includeProfile: true, updatesLimit: 20 });
  assert.equal(second.positions[0].walletAddress, "wallet-3");
  assert.equal((second.positions[0].callout as any).thesis, "thesis");
  assert.deepEqual((second.positions[0].callout as any).updates, []);
  assert.equal((second.positions[0].profile as any).username, "name-3");
});

test("the startup loader reads only a bounded regular file", () => {
  const dir = mkdtempSync(join(tmpdir(), "mint-positions-"));
  try {
    const file = join(dir, "holders.json");
    writeFileSync(file, JSON.stringify(dataset()));
    assert.equal(loadMintPositionsStore(undefined), undefined);
    assert.equal(loadMintPositionsStore(file)!.page("MintA", { sortBy: "TOP" }).positions.length, 5);
    const link = join(dir, "link.json");
    symlinkSync(file, link);
    assert.throws(() => loadMintPositionsStore(link));
    // Where O_NOFOLLOW is unavailable (Windows), the symlink is still refused.
    assert.throws(() => loadMintPositionsStore(link, 0), /file type/);
    assert.throws(() => loadMintPositionsStore(dir, 0), /file type/);
    assert.ok(loadMintPositionsStore(file, 0));
    writeFileSync(file, Buffer.from([0x7b, 0xff, 0x7d]));
    assert.throws(() => loadMintPositionsStore(file), TypeError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
