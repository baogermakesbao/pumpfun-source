# Opt-in local curated video feed

`GET /v1/feed/video-feed` now has an independently implemented, opt-in read
model for a supplied curated feed of clips and live coins. Without
`videoFeedStore` / `VIDEO_FEED_FILE`, the existing explicit fixture replay or
`501 COMPATIBILITY_NOT_IMPLEMENTED` remains. No synthetic feed is enabled by
default. This does not implement curation or ranking, livestream-service
lookups, clip hiding or deletion, coin enrichment, a production proxy, or a
native-compatible feed service.

## Declared source, not recovered backend code

- Developer operation `GET /feed/video-feed`, scope `content.read`, declared
  origin `https://api.pump.fun/v1`. Website service binding remains
  unresolved.
- OpenAPI 0.294.0: `contracts/developer.openapi.json`, SHA-256
  `ad2fdc2bbf0b86d92e01f539ca609fff8164fcc44556bb2691378a869f73ad73`.
  Its strict item schema validates every supplied item at startup and every
  in-process response in tests.
- `contracts/developer-bindings.json` binds the route to raw source
  `evidence/web/objects/2b47dd0b38a1608f.js` (507,700 bytes, SHA-256
  `e78d2f38b06f971847c18dd05457c75afc85208135f50d6e4022a5f197e8839d`).
  The variant schema, the clip record schema and the route declaration are
  UTF-16 range `[161737, 163755)`, which hashes to
  `3c5603745bab79feb9bf299ab3965dca99ad2432f2622d8864127775109d51b4`.
  Tests read/hash this text; they never import or execute captured code.

The declared contract establishes: **no query parameters**; an array of items
discriminated by `feedItemType`, either `clip` (a clip record and its coin) or
`live` (a coin); the clip record is "the livestream-service clip record,
forwarded verbatim", its `roomName` is "the coin mint the clip was recorded
in", its start and end times are ISO 8601, `duration` is in seconds, and
`hidden` is "always false here: hidden clips are filtered out of the feed".
Coin rows guarantee only `mint`. Their descriptions declare that `name` and
`symbol` are never blank; `description`, `image_uri` and `metadata_uri` are
never the empty string; `image_backdrop` appears only beside `image_uri`;
`usd_market_cap` is absent rather than 0; `thumbnail`, `thumbnail_updated_at`
and `num_participants` are set only while `is_currently_live`; and `issuer`
and `underlying_symbol` are set only alongside `asset_class`. The contract
does not declare the curation order, a size, or paging.

## Explicit local input and policies

`VideoFeedDataset` in `src/video-feed-store.ts` is a **local schema**, not an
upstream database schema. A caller supplies the already-curated items. The
producer is responsible for curation, hiding, deletion, livestream state,
coin enrichment and authorized local data. The read model does not compute
them or accept ingestion through HTTP.

- Items are served verbatim in supplied order, at most 1,000. Each must match
  the pinned item schema exactly, so undeclared clip, coin or item keys reject
  the dataset.
- Each coin must satisfy the declared invariants listed above. `issuer` or
  `underlying_symbol` with a non-null value needs a non-null `asset_class`.
- A clip's `roomName` must equal its item's `coin.mint`, and `hidden` may only
  be absent or `false`. Clip ids are unique, and so are live coin mints.
- Clip start and end times must be ISO 8601 date-times with `Z` or a `±hh:mm`
  offset and up to nine fraction digits, kept verbatim. Every component must
  be in range, so values that `Date.parse` would silently roll over (Feb 30,
  hour 24, minute 60) are rejected. Once offsets are applied, the end may not
  precede the start or follow `observedAt`.
- `duration` is non-negative and not compared with the times. `viewCount` and
  `mp4SizeBytes` are non-negative integers when present. Other forwarded
  strings, such as `createdAt` or `deletionStatus`, keep their declared types
  only.
- A supplied empty feed is a `200` with `[]`. Any query key, including an
  empty one, receives local `400 INVALID_QUERY`.
- Malformed datasets fail at startup. Responses identify their data source and
  observation timestamp and explicitly set
  `X-Reconstruction-Compatibility: unqualified`.

The existing developer API-key **shape-only compatibility gate** still runs
before this route. It does not verify credentials, checksums, scopes,
revocation, rate limits or ownership. No new credential path is added.

## Optional startup configuration

Set server-only `VIDEO_FEED_FILE` to an explicit local UTF-8 JSON file, or
inject `new VideoFeedStore(dataset)` into `buildApp([], { videoFeedStore })`.
The file loader refuses a symlink or non-regular path (also where
`O_NOFOLLOW` is unavailable), binds the opened descriptor to the inspected
file, reads at most 16 MiB, validates before serving, and closes its
descriptor in `finally`. It performs no writes/reloads or network access. The
constructed store keeps a serialized snapshot, so callers cannot mutate it
through input or returned objects. No dependency or lockfile change is
needed.

Minimal deliberately empty **synthetic** inventory (not a production fixture):

```json
{
  "schemaVersion": 1,
  "dataSource": "synthetic",
  "observedAt": "2026-10-29T00:00:00.000Z",
  "items": []
}
```

## Verification and remaining limits

Based on main `630a074126a13d4133514d599129c6ac9a3179bc`. Before the change, Fastify `inject` returned `501`
for the documented route. With an explicit synthetic feed, the new handler
returns a schema-checked `200`; without one it still returns `501` or the
explicit fixture.

From `app/packages/backend`:

```sh
node --import tsx --test test/video-feed.test.ts
node --import tsx --test test/*.test.ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc -p tsconfig.json
./node_modules/.bin/tsc --noEmit --strict --target ES2022 --module NodeNext \
  --moduleResolution NodeNext --esModuleInterop --resolveJsonModule \
  --skipLibCheck --types node test/video-feed.test.ts
```

All focused requests use in-process `Fastify.inject` and synthetic identifiers.
This is not an aggregate application/browser/evidence-gate pass, nor a
production differential test. No backend compatibility count, feature
milestone, native feed parity, security guarantee, or Slop workflow
completion is claimed.
