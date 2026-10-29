import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildApp, type Fixture } from "../src/app.js";
import { VideoFeedStore, loadVideoFeedStore, type VideoFeedDataset } from "../src/video-feed-store.js";
import { assertSchema } from "../src/schema-validator.js";

const now = "2026-10-29T00:00:00.000Z";
// Synthetic shape-only credential for in-process compatibility-gate tests.
const headers = { authorization: `Bearer pf_live_${"a".repeat(49)}` };
const spec = JSON.parse(
  readFileSync(new URL("../../../contracts/developer.openapi.json", import.meta.url), "utf8"),
);
const okSchema = spec.paths["/feed/video-feed"].get.responses["200"].content["application/json"].schema;

function dataset(): VideoFeedDataset {
  return {
    schemaVersion: 1,
    dataSource: "synthetic",
    observedAt: now,
    items: [
      {
        feedItemType: "clip",
        clip: {
          roomName: "ClipMint",
          clipId: "clip-1",
          startTime: "2026-10-28T10:00:00.000Z",
          endTime: "2026-10-28T10:00:30.000Z",
          duration: 30,
          playlistUrl: "https://example.invalid/clip-1.m3u8",
          thumbnailUrl: "https://example.invalid/clip-1.jpg",
          thumbnailS3Key: "clips/clip-1.jpg",
          playlistS3Key: "clips/clip-1.m3u8",
          variants: [
            { name: "low", height: 360, playlistUrl: "https://example.invalid/low.m3u8" },
            { name: "ultra", height: 2160, playlistUrl: "https://example.invalid/ultra.m3u8", playlistS3Key: "u.m3u8" },
          ],
          hidden: false,
          clipType: "HIGHLIGHT",
          viewCount: 12,
          mp4SizeBytes: 1_048_576,
        },
        coin: { mint: "ClipMint", name: "Clip Coin", symbol: "CLIP", image_uri: "https://example.invalid/c.png", usd_market_cap: 42_000 },
      },
      {
        feedItemType: "live",
        coin: { mint: "LiveMint", is_currently_live: true, thumbnail: "https://example.invalid/live.jpg", num_participants: 7 },
      },
      {
        feedItemType: "clip",
        // Verbatim upstream form: an offset zone and no fraction.
        clip: {
          roomName: "ClipMint",
          clipId: "clip-2",
          startTime: "2026-10-28T17:00:00+07:00",
          endTime: "2026-10-28T17:00:05+07:00",
          duration: 5,
          thumbnailUrl: "https://example.invalid/clip-2.jpg",
          thumbnailS3Key: "clips/clip-2.jpg",
          playlistS3Key: "clips/clip-2.m3u8",
        },
        coin: { mint: "ClipMint" },
      },
    ],
  };
}
function app(store?: VideoFeedStore, fixtures: Fixture[] = []) {
  return buildApp(fixtures, store ? { videoFeedStore: store } : {});
}
function get(server: ReturnType<typeof buildApp>, query = "") {
  return server.inject({ method: "GET", url: `/v1/feed/video-feed${query}`, headers });
}

test("the declared contract text is the pinned captured range", () => {
  // Read and hash only; captured code is never imported or executed.
  const source = readFileSync(
    new URL("../../../evidence/web/objects/2b47dd0b38a1608f.js", import.meta.url),
    "utf8",
  );
  const route = source.slice(161737, 163755);
  assert.equal(createHash("sha256").update(route).digest("hex"), "3c5603745bab79feb9bf299ab3965dca99ad2432f2622d8864127775109d51b4");
  for (const phrase of [
    'l=o.z.object({name:(0,i.openEnum)(["low","mid","high"]',
    'roomName:o.z.string().describe("The coin mint the clip was recorded in")',
    'startTime:o.z.string().describe("ISO 8601")',
    'hidden:o.z.boolean().optional().describe("Always false here: hidden clips are filtered out of the feed")',
    'describe("The livestream-service clip record, forwarded verbatim")',
    '"GET /feed/video-feed":(0,s.publicRead)("content.read",{summary:"Get the curated video feed"',
    'o.z.discriminatedUnion("feedItemType",[o.z.object({feedItemType:o.z.literal("clip"),clip:d,coin:a.coinDto}),o.z.object({feedItemType:o.z.literal("live"),coin:a.coinDto})])',
  ])
    assert.ok(route.includes(phrase), phrase);
  assert.ok(!route.slice(route.indexOf('"GET /feed/video-feed"')).includes("query:"));
});

test("the supplied curated feed is served verbatim in supplied order", async () => {
  const res = await get(app(new VideoFeedStore(dataset())));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-reconstruction-data-source"], "synthetic");
  assert.equal(res.headers["x-reconstruction-observed-at"], now);
  assert.equal(res.headers["x-reconstruction-compatibility"], "unqualified");
  const body = res.json();
  assertSchema(body, okSchema, "video feed", spec);
  assert.equal(body[2].clip.startTime, "2026-10-28T17:00:00+07:00");
  assert.deepEqual(body, dataset().items);
});

test("a supplied empty feed is an empty 200", async () => {
  const d = dataset();
  d.items = [];
  const res = await get(app(new VideoFeedStore(d)));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), []);
});

test("the operation declares no query parameters", async () => {
  const server = app(new VideoFeedStore(dataset()));
  for (const query of ["?limit=10", "?cursor=x", "?", "?=", "?a"]) {
    const res = await get(server, query);
    const expected = query === "?" ? 200 : 400;
    assert.equal(res.statusCode, expected, query);
    if (expected === 400) assert.deepEqual(res.json(), { statusCode: 400, error: "INVALID_QUERY" }, query);
  }
});

test("the developer API-key gate still runs first", async () => {
  const res = await app(new VideoFeedStore(dataset())).inject({ method: "GET", url: "/v1/feed/video-feed" });
  assert.equal(res.statusCode, 401);
});

test("without a store the documented route keeps fixture replay or 501", async () => {
  const fixture: Fixture = {
    method: "GET",
    path: "/v1/feed/video-feed",
    status: 200,
    body: [],
    source: "synthetic test fixture",
  };
  assert.equal((await get(app())).statusCode, 501);
  const replay = await get(app(undefined, [fixture]));
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.headers["x-reconstruction-data-source"], undefined);
  const native = await get(app(new VideoFeedStore(dataset()), [fixture]));
  assert.equal(native.json().length, 3);
});

test("clip times accept ISO 8601 with a zone and reject anything that rolls over", () => {
  const withTimes = (startTime: string, endTime: string) => {
    const d = dataset() as any;
    Object.assign(d.items[0].clip, { startTime, endTime });
    return d;
  };
  for (const [start, end] of [
    ["2026-10-28T10:00:00Z", "2026-10-28T10:00:00.5Z"],
    ["2026-10-28T10:00:00.123456789Z", "2026-10-28T10:00:01Z"],
    ["2026-10-28T05:00:00-05:00", "2026-10-28T10:00:00.000Z"], // same instant
    // Ordered only once each offset is applied with its sign.
    ["2026-10-28T10:00:00Z", "2026-10-28T05:00:01-05:00"],
    ["2026-10-28T12:00:00+05:00", "2026-10-28T08:00:00Z"],
    ["2024-02-29T00:00:00Z", "2024-02-29T23:59:59.999Z"],
    ["2026-10-28T23:00:00Z", now],
  ])
    assert.doesNotThrow(() => new VideoFeedStore(withTimes(start, end)), `${start} ${end}`);
  for (const [start, end] of [
    ["2026-02-29T00:00:00Z", "2026-03-01T00:00:00Z"],
    ["2026-04-31T00:00:00Z", "2026-05-01T00:00:00Z"],
    ["2026-10-28T24:00:00Z", "2026-10-28T24:00:00Z"],
    ["2026-10-28T10:60:00Z", "2026-10-28T11:00:00Z"],
    ["2026-10-28T10:00:60Z", "2026-10-28T11:00:00Z"],
    ["2026-13-01T00:00:00Z", "2026-13-01T00:00:00Z"],
    ["2026-00-10T00:00:00Z", "2026-01-01T00:00:00Z"],
    ["2026-10-00T00:00:00Z", "2026-10-01T00:00:00Z"],
    ["2026-10-28T10:00:00+24:00", "2026-10-28T10:00:00Z"],
    ["2026-10-28T10:00:00+05:60", "2026-10-28T10:00:00Z"],
    ["2026-10-28T10:00:00", "2026-10-28T10:00:01Z"],
    ["2026-10-28 10:00:00Z", "2026-10-28T10:00:01Z"],
    ["1761645600000", "2026-10-28T10:00:01Z"],
    // A valid start with an end that Date.parse alone would accept.
    ["2026-10-28T10:00:00Z", "2026-10-28T24:00:00Z"],
    ["2026-10-28T10:00:00Z", "2026-10-28T10:00:01"],
    ["2026-10-28T10:00:01Z", "2026-10-28T10:00:00Z"], // ends before it starts
    ["2026-10-28T10:00:00Z", "2026-10-29T00:00:00.001Z"], // ends after the snapshot
    ["2026-10-28T11:00:00+01:00", "2026-10-28T09:59:59Z"], // offsets are applied
  ])
    assert.throws(() => new VideoFeedStore(withTimes(start, end)), TypeError, `${start} ${end}`);
});

test("malformed datasets fail at construction", () => {
  const clip = (d: any) => d.items[0].clip;
  const coin = (d: any) => d.items[0].coin;
  const live = (d: any) => d.items[1].coin;
  const mutations: [string, (d: any) => void][] = [
    ["extra root key", (d) => { d.extra = 1; }],
    ["missing root key", (d) => { delete d.items; }],
    ["version", (d) => { d.schemaVersion = 2; }],
    ["source", (d) => { d.dataSource = "live"; }],
    ["non-canonical observedAt", (d) => { d.observedAt = "2026-10-29T00:00:00Z"; }],
    // Shaped like toISOString output; Date.parse silently rolls it over to the next day.
    ["rolled-over observedAt", (d) => { d.observedAt = "2026-10-28T24:00:00.000Z"; }],
    ["items object", (d) => { d.items = {}; }],
    ["too many items", (d) => { d.items = Array.from({ length: 1001 }, (_, i) => ({ feedItemType: "live", coin: { mint: `m${i}` } })); }],
    ["hole in items", (d) => { d.items = [d.items[0], , d.items[1]]; }],
    ["unknown item type", (d) => { d.items[1].feedItemType = "post"; }],
    ["live item with clip", (d) => { d.items[1].clip = structuredClone(clip(d)); }],
    ["clip item without clip", (d) => { delete d.items[0].clip; }],
    ["extra item key", (d) => { d.items[1].rank = 1; }],
    ["coin without mint", (d) => { delete live(d).mint; }],
    ["undeclared coin key", (d) => { coin(d).price_sol = 1; }],
    ["undeclared clip key", (d) => { clip(d).streamKey = "x"; }],
    ["missing clip thumbnail", (d) => { delete clip(d).thumbnailUrl; }],
    ["string duration", (d) => { clip(d).duration = "30"; }],
    ["variant without height", (d) => { delete clip(d).variants[0].height; }],
    ["duplicate clip", (d) => { d.items[2].clip.clipId = "clip-1"; }],
    ["duplicate live coin", (d) => { d.items.push(structuredClone(d.items[1])); }],
    ["clip from another room", (d) => { clip(d).roomName = "OtherMint"; }],
    ["hidden clip", (d) => { clip(d).hidden = true; }],
    ["negative duration", (d) => { clip(d).duration = -1; }],
    ["fractional view count", (d) => { clip(d).viewCount = 1.5; }],
    ["negative view count", (d) => { clip(d).viewCount = -1; }],
    ["fractional mp4 size", (d) => { clip(d).mp4SizeBytes = 0.5; }],
    ["blank coin name", (d) => { coin(d).name = "  "; }],
    ["empty coin symbol", (d) => { coin(d).symbol = ""; }],
    ["empty description", (d) => { coin(d).description = ""; }],
    ["empty image_uri", (d) => { coin(d).image_uri = ""; }],
    ["empty metadata_uri", (d) => { coin(d).metadata_uri = ""; }],
    ["backdrop without image", (d) => { live(d).image_backdrop = "dark"; }],
    ["zero usd market cap", (d) => { coin(d).usd_market_cap = 0; }],
    ["live thumbnail while not live", (d) => { live(d).is_currently_live = false; }],
    ["participants without live flag", (d) => { delete live(d).is_currently_live; delete live(d).thumbnail; }],
    ["thumbnail time without live flag", (d) => { coin(d).thumbnail_updated_at = 1; }],
    ["thumbnail without live flag", (d) => { coin(d).thumbnail = "https://example.invalid/t.jpg"; }],
    ["issuer without asset class", (d) => { coin(d).issuer = "xstocks"; }],
    ["issuer beside null asset class", (d) => { Object.assign(coin(d), { issuer: "xstocks", asset_class: null }); }],
    ["underlying symbol without asset class", (d) => { coin(d).underlying_symbol = "AAPL"; }],
  ];
  assert.doesNotThrow(() => new VideoFeedStore(dataset()));
  for (const [label, mutate] of mutations) {
    const d = structuredClone(dataset()) as any;
    mutate(d);
    assert.throws(() => new VideoFeedStore(d), TypeError, label);
  }
});

test("declared coin facts the contract allows are accepted", () => {
  const d = dataset() as any;
  Object.assign(d.items[0].coin, {
    image_backdrop: "light",
    issuer: "xstocks",
    underlying_symbol: "AAPL",
    asset_class: "tokenized_stock",
    description: "A clip coin",
    transfer_hook_program: "",
  });
  Object.assign(d.items[2].coin, { issuer: null, underlying_symbol: null, asset_class: null, is_currently_live: false });
  d.items[1].coin.thumbnail_updated_at = Date.parse(now);
  Object.assign(d.items[0].clip, { viewCount: 0, mp4SizeBytes: 0, duration: 0 });
  assert.doesNotThrow(() => new VideoFeedStore(d));
});

test("the store owns its data against input and response mutation", () => {
  const d = dataset();
  const store = new VideoFeedStore(d);
  (d.items[0] as any).clip.clipId = "changed";
  d.items.reverse();
  const first = store.feed();
  (first[0] as any).clip.variants[0].height = 1;
  first[1].coin.mint = "mutated";
  first.pop();
  assert.deepEqual(store.feed(), dataset().items);
});

test("the startup loader reads only a bounded regular file", () => {
  const dir = mkdtempSync(join(tmpdir(), "video-feed-"));
  try {
    const file = join(dir, "feed.json");
    writeFileSync(file, JSON.stringify(dataset()));
    assert.equal(loadVideoFeedStore(undefined), undefined);
    assert.equal(loadVideoFeedStore(file)!.feed().length, 3);
    const link = join(dir, "link.json");
    symlinkSync(file, link);
    assert.throws(() => loadVideoFeedStore(link));
    // Where O_NOFOLLOW is unavailable (Windows), the symlink is still refused.
    assert.throws(() => loadVideoFeedStore(link, 0), /file type/);
    assert.throws(() => loadVideoFeedStore(dir, 0), /file type/);
    assert.ok(loadVideoFeedStore(file, 0));
    writeFileSync(file, Buffer.from([0x7b, 0xff, 0x7d]));
    assert.throws(() => loadVideoFeedStore(file), TypeError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
