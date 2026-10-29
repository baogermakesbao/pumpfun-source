# Opt-in local mint holders (spot, offset sorts)

`GET /v1/mint-positions/{mint}` now has an independently implemented, opt-in
read model for supplied spot holders of a mint. Without `mintPositionsStore` /
`MINT_POSITIONS_FILE`, the existing explicit fixture replay or
`501 COMPATIBILITY_NOT_IMPLEMENTED` remains. No synthetic holders are enabled
by default. This is a deliberately partial slice: it does not implement the
RANKED ranker, the dust floor, perp/NEAR/Starknet/TON holders, `scope=pairs`,
low-quality verdicts, PnL folding, holder discovery, a production proxy, or a
native-compatible positions service. Those inputs fail closed with `501`.

The existing [spot positions read model](POSITIONS.md) is unchanged; its
dataset carries no holder identity, so this route takes its own explicit input
rather than guessing usernames or profiles.

## Declared source, not recovered backend code

- Developer operation `GET /mint-positions/{mint}`, scope `positions.read`,
  declared origin `https://api.pump.fun/v1`. Website service binding remains
  unresolved.
- OpenAPI 0.294.0: `contracts/developer.openapi.json`, SHA-256
  `ad2fdc2bbf0b86d92e01f539ca609fff8164fcc44556bb2691378a869f73ad73`.
  Its strict success schema is checked against real in-process responses, and
  its row schema (callout and profile included) validates every supplied row.
- `contracts/developer-bindings.json` binds the route to raw source
  `evidence/web/objects/2b47dd0b38a1608f.js` (507,700 bytes, SHA-256
  `e78d2f38b06f971847c18dd05457c75afc85208135f50d6e4022a5f197e8839d`).
  The route declaration is UTF-16 range `[273021, 278872)`, which hashes to
  `48e75fa2f3e8a7d7482cf3f37e27bbdb7248e1cd6baf23400b95bb4c07a0c96b`; the
  shared `mintPositionDto` is `[471229, 475412)`, hashing to
  `314628be8a9cc85ba474677fdbeb14901adce1d2d3b56878ace0114083b164de`.
  Tests read/hash this text; they never import or execute captured code.

The declared contract establishes:

- `CLOSED_PNL` serves fully exited positions ranked by realized PnL USD
  descending, losses last, and requires `withThesis=true`; every other sort
  serves open holders. `dustFloorUsd` is rejected with `CLOSED_PNL`.
- `withThesis` filters to holders whose callout has a thesis, applied before
  paging. `pageSize` is 1..50. `updatesLimit` is 0..20, omitted serves 5, and 0
  skips update enrichment.
- `includeProfile` embeds the registry profile, null for wallet-only holders;
  without it the key is absent.
- `totalCount`: the open sorts count the mint's open holders; `CLOSED_PNL`
  counts the closed holders that have a callout for this mint.
- Offset sorts derive `hasMore` from `totalCount`; it is always false on an
  empty page, and on a thesis-filtered list it may be true for the last
  non-empty page.
- Positions are keyed `(wallet, mint, chain)`. `pageToken`, `forceRefresh`,
  `chainId`, `session_id`, `device_id`, `country`, `os` and `platform` are
  RANKED-only, and `pageToken` excludes `page`.
- `hasLiked`/`hasReposted` are null until a viewer is known, and a quoted
  callout is one level deep.

## Explicit local input and policies

`MintPositionsDataset` in `src/mint-positions-store.ts` is a **local schema**,
not an upstream database schema. Per mint, a caller supplies the open holders,
the producer's order for each open sort as indices into them, and the closed
holders (or `null` when not materialized). Each holder is a pinned OpenAPI row
plus its profile. The producer is responsible for PnL, the order behind TOP,
LATEST and LOWEST_ENTRY (including the default $5 LOWEST_ENTRY dust floor),
identity and authorized local data.

- TOP and LATEST must order every open holder; LOWEST_ENTRY may omit some. An
  unsupplied order is `501 SORT_ORDER_UNAVAILABLE`, never another sort.
  CLOSED_PNL is computed here, with a **local** wallet/chain tie order.
- Omitted `sortBy` is `501 DEFAULT_SORT_UNDECLARED`: the server default is not
  declared (the captured web client always sends one), so none is guessed.
- The default `pageSize` of 50 (the declared ceiling) is local.
- A thesis is a non-blank string (local). Updates are truncated in supplied
  order.
- Spot only: rows may not carry `chain`, `assetClass`, `perp`, RANKED fields or
  an inline `profile`. Open holders hold a non-zero amount and closed holders
  hold zero (local admission). `(walletAddress, chainId)` is unique per list,
  rows must name their mint, at most 20 updates per callout are accepted, and
  callouts must be viewerless.
- An unknown mint is `501 MINT_POSITIONS_UNAVAILABLE` (not an empty list);
  unmaterialized closed holders are `501 CLOSED_POSITIONS_UNAVAILABLE`.
- `RANKED`, a valid `chain`, `scope=pairs` and an explicit `dustFloorUsd` are
  `501` (`RANKED_UNAVAILABLE`, `CHAIN_UNAVAILABLE`, `PAIRS_SCOPE_UNAVAILABLE`,
  `DUST_FLOOR_UNAVAILABLE`). `scope=mint` is the default and served.
- Canonical decimal syntax is local policy. Unknown or repeated keys,
  out-of-range values, RANKED-only inputs on another sort, and the declared
  rejections receive local `400 INVALID_QUERY`.
- Responses identify their data source and observation timestamp and
  explicitly set `X-Reconstruction-Compatibility: unqualified`.

The existing developer API-key **shape-only compatibility gate** still runs
before this route. It does not verify credentials, checksums, scopes,
revocation, rate limits or ownership. No new credential path is added.

## Optional startup configuration

Set server-only `MINT_POSITIONS_FILE` to an explicit local UTF-8 JSON file, or
inject `new MintPositionsStore(dataset)` into
`buildApp([], { mintPositionsStore })`. The file loader refuses a symlink or
non-regular path (also where `O_NOFOLLOW` is unavailable), binds the opened
descriptor to the inspected file, reads at most 16 MiB, validates before
serving, and closes its descriptor in `finally`. It performs no writes/reloads
or network access. Limits are 10,000 mints and 10,000 holders per list. The
constructed store owns its data; callers cannot mutate it through input or
returned objects. No dependency or lockfile change is needed.

Minimal deliberately empty **synthetic** inventory (not a production fixture):

```json
{
  "schemaVersion": 1,
  "dataSource": "synthetic",
  "observedAt": "2026-10-29T00:00:00.000Z",
  "mints": {}
}
```

## Verification and remaining limits

Based on main `04be15f61e66d27282e2af3d581de984389eac90`. Before the change,
Fastify `inject` returned `501` for the documented route. With explicit
synthetic holders, the new handler returns a schema-checked `200`; without them
it still returns `501` or the explicit fixture.

From `app/packages/backend`:

```sh
node --import tsx --test test/mint-positions.test.ts
node --import tsx --test test/*.test.ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc -p tsconfig.json
./node_modules/.bin/tsc --noEmit --strict --target ES2022 --module NodeNext \
  --moduleResolution NodeNext --esModuleInterop --resolveJsonModule \
  --skipLibCheck --types node test/mint-positions.test.ts
```

All focused requests use in-process `Fastify.inject` and synthetic identifiers.
This is not an aggregate application/browser/evidence-gate pass, nor a
production differential test. No backend compatibility count, feature
milestone, native positions parity, security guarantee, or Slop workflow
completion is claimed.
