# Opt-in local PnL position leaderboard

`GET /v1/pnl-leaderboard/positions` now has an independently implemented,
opt-in read model for supplied position board rows. Without
`pnlPositionsStore` / `PNL_POSITIONS_FILE`, the existing explicit fixture
replay or `501 COMPATIBILITY_NOT_IMPLEMENTED` remains. No synthetic board is
enabled by default. This does not implement PnL folding, ranking, callout
linking, profile enrichment, the followed-holders overlay, viewer fields,
sessions, a production proxy, or a native-compatible leaderboard service.

## Declared source, not recovered backend code

- Developer operation `GET /pnl-leaderboard/positions`, scope
  `leaderboards.read`, declared origin `https://api.pump.fun/v1`. Website
  service binding remains unresolved.
- OpenAPI 0.294.0: `contracts/developer.openapi.json`, SHA-256
  `ad2fdc2bbf0b86d92e01f539ca609fff8164fcc44556bb2691378a869f73ad73`.
  Its strict success schema is checked against real in-process responses, and
  its callout schema validates every supplied callout.
- `contracts/developer-bindings.json` binds the route to raw source
  `evidence/web/objects/2b47dd0b38a1608f.js` (507,700 bytes, SHA-256
  `e78d2f38b06f971847c18dd05457c75afc85208135f50d6e4022a5f197e8839d`).
  The route declaration is UTF-16 range `[311462, 312223)`, which hashes to
  `0a7fe19ecc166a10c4cd98c2ba42d5b2d615e2aaad61efbb9b2791885cf62c97`; the
  position row contract is `[306985, 308626)`, hashing to
  `6f635e524ccafb37178a118f7a12df149540952300e18a98d7893556902e2840`.
  Tests read/hash this text; they never import or execute captured code.

The declared contract establishes: a required `daily`/`weekly` period (no
monthly board); `limit` rows with default and ceiling 25; an opt-in
`includeFollowedHolders` facepile that is viewer-relative, so the API host,
having no viewer, serves `followedHolders: null`; `followedHoldersLimit` of at
least 1, values above 10 clamping; a callout on every row ("Never null — a row
without a callout is dropped from the board"); `hasLiked`/`hasReposted` null
until a viewer is known; a quoted callout only one level deep; profile fields
present only when the board had a wallet to enrich; and `totalRanked`.

The captured row also declares `receiptBasisUsd` and
`resolvedAvatarDecoration`, absent from OpenAPI 0.294.0's
`additionalProperties: false` row schema. This developer route deliberately
follows the pinned OpenAPI and omits them, as `PAYOUTS.md` does for its newer
field. `isViewer` and `viewerFollows` are viewer-relative and never served.

## Explicit local input and policies

`PnlPositionsDataset` in `src/pnl-positions-store.ts` is a **local schema**,
not an upstream database schema. A caller supplies, per period, a complete,
already-ranked board of position rows (each with its callout and an optional
profile), the period label and window start, and an observation timestamp.
The producer is responsible for folding, ranking, callout linking, enrichment
and authorized local data. The read model does not compute PnL, fetch callouts
or profiles, or accept ingestion through HTTP.

- The supplied row order **is** the ranking; ranks are one-based positions in
  it. No ranking measure is assumed and rows are never re-sorted.
  `totalRanked` counts the whole supplied board, before the row limit.
- Negative row limits clamp to an empty page; that lower bound is local.
- A board's rows either all carry the six pinned profile fields or none do
  (local reading of the per-board enrichment rule).
- Each callout must satisfy the pinned callout schema with `hasLiked` and
  `hasReposted` null, and a quoted callout's own `quotedCallout` must be null.
- `(walletAddress, coinMint)` is unique per board (local), measures must be
  finite or null, and refresh and window times may not be later than
  `observedAt`. Malformed or extra fields reject the dataset at startup.
- `periodLabel` and `windowStartSec` are supplied, never guessed. A valid
  period without a supplied board returns `501` with
  `PNL_POSITIONS_BOARD_UNAVAILABLE`, never another period's board.
- Canonical decimal integer and `true`/`false` syntax are local policy.
  Unknown or repeated query keys, `monthly`, and malformed values receive local
  `400 INVALID_QUERY`.
- Responses identify their data source and observation timestamp and
  explicitly set `X-Reconstruction-Compatibility: unqualified`.

The existing developer API-key **shape-only compatibility gate** still runs
before this route. It does not verify credentials, checksums, scopes,
revocation, rate limits or ownership. No new credential path is added.

## Optional startup configuration

Set server-only `PNL_POSITIONS_FILE` to an explicit local UTF-8 JSON file, or
inject `new PnlPositionsStore(dataset)` into
`buildApp([], { pnlPositionsStore })`. The file loader refuses a symlink or
non-regular path (also where `O_NOFOLLOW` is unavailable), binds the opened
descriptor to the inspected file, reads at most 16 MiB, validates before
serving, and closes its descriptor in `finally`. It performs no writes/reloads
or network access. The limit is 10,000 rows per board. The constructed store
owns its data; callers cannot mutate it through input or returned objects. No
dependency or lockfile change is needed.

Minimal deliberately empty **synthetic** inventory (not a production fixture):

```json
{
  "schemaVersion": 1,
  "dataSource": "synthetic",
  "observedAt": "2026-10-29T00:00:00.000Z",
  "boards": {}
}
```

## Verification and remaining limits

Based on main `1d5a559695c9f945b553da3a229e124d0fbc3586`. Before the change,
Fastify `inject` returned `501` for the documented route. With explicit
synthetic rows, the new handler returns a schema-checked `200`; without them it
still returns `501` or the explicit fixture.

From `app/packages/backend`:

```sh
node --import tsx --test test/pnl-positions.test.ts
node --import tsx --test test/*.test.ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc -p tsconfig.json
./node_modules/.bin/tsc --noEmit --strict --target ES2022 --module NodeNext \
  --moduleResolution NodeNext --esModuleInterop --resolveJsonModule \
  --skipLibCheck --types node test/pnl-positions.test.ts
```

All focused requests use in-process `Fastify.inject` and synthetic identifiers.
This is not an aggregate application/browser/evidence-gate pass, nor a
production differential test. No backend compatibility count, feature
milestone, native leaderboard parity, security guarantee, or Slop workflow
completion is claimed.
