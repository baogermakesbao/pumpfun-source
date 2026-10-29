# Opt-in local per-coin mayhem trader board

`GET /v1/mayhem/{mint}/top-traders` now has an independently implemented,
opt-in read model for supplied per-coin trader snapshots. Without
`mayhemTopTradersStore` / `MAYHEM_TOP_TRADERS_FILE`, the existing explicit
fixture replay or `501 COMPATIBILITY_NOT_IMPLEMENTED` remains. No synthetic
board is enabled by default. This does not implement trade folding, PnL or
market-cap averaging, ranking, profile lookup, mayhem state, the global
`/mayhem/top-traders` or `/mayhem/top-coins` boards, a production proxy, or a
native-compatible mayhem service.

## Declared source, not recovered backend code

- Developer operation `GET /mayhem/{mint}/top-traders`, scope
  `leaderboards.read`, declared origin `https://api.pump.fun/v1`. Website
  service binding remains unresolved.
- OpenAPI 0.294.0: `contracts/developer.openapi.json`, SHA-256
  `ad2fdc2bbf0b86d92e01f539ca609fff8164fcc44556bb2691378a869f73ad73`.
  Its strict success schema is checked against real in-process responses.
- `contracts/developer-bindings.json` binds the route to raw source
  `evidence/web/objects/2b47dd0b38a1608f.js` (507,700 bytes, SHA-256
  `e78d2f38b06f971847c18dd05457c75afc85208135f50d6e4022a5f197e8839d`).
  The route declaration is UTF-16 range `[266655, 267511)`, which hashes to
  `7461ebef83e314c8038db91da214c813ea1f00632755131064fd50af94068c28`.
  Tests read/hash this text; they never import or execute captured code.

The declared contract establishes: a `mint` path parameter and **no query
parameters**; a response echoing `mint`, the snapshot time `updatedAt` in epoch
milliseconds, and `traders` rows with a rank, address, nullable profile
fields, realised PnL, nullable average entry/exit market caps, buy/sell totals
and transaction counts, `tokenBalance` as a raw-amount string that may exceed
`Number.MAX_SAFE_INTEGER`, token amounts, and `lastActivityAt` in epoch
**seconds**. The operation declares no `404` (a sibling partner route's
"never been in Mayhem" 404 is not borrowed) and no ranking measure.

## Explicit local input and policies

`MayhemTopTradersDataset` in `src/mayhem-top-traders-store.ts` is a **local
schema**, not an upstream database schema. Per mint, a caller supplies a
snapshot time and the already-ranked trader rows. The producer is responsible
for folding trades, PnL, averages, ranking, profiles and authorized local
data. The read model does not compute them or accept ingestion through HTTP.

- Rows are served in supplied order with supplied ranks: positive integers that
  never decrease, so ties are allowed. No measure is assumed and rows are never
  re-sorted.
- A supplied empty board is a `200` with no traders. A mint without a supplied
  board returns `501` with `MAYHEM_BOARD_UNAVAILABLE`, never a fabricated empty
  board. Mints match exactly; there is no case folding.
- Any query key, including an empty one, receives local `400 INVALID_QUERY`.
- `tokenBalance` must be a canonical non-negative decimal integer string below
  2^256 and is served exactly. USD totals, token amounts and market caps are
  non-negative; transaction counts are non-negative integers; realised PnL is
  any finite number.
- Local consistency: a side with zero transactions carries zero USD, zero token
  amount and a null average. `updatedAt` may not be later than `observedAt`,
  and `lastActivityAt` (seconds) may not be later than `updatedAt`.
- Addresses are unique per board; supplied text is served verbatim. Malformed
  or extra fields reject the dataset at startup.
- Responses identify their data source and observation timestamp and
  explicitly set `X-Reconstruction-Compatibility: unqualified`.

The existing developer API-key **shape-only compatibility gate** still runs
before this route. It does not verify credentials, checksums, scopes,
revocation, rate limits or ownership. No new credential path is added.

## Optional startup configuration

Set server-only `MAYHEM_TOP_TRADERS_FILE` to an explicit local UTF-8 JSON file,
or inject `new MayhemTopTradersStore(dataset)` into
`buildApp([], { mayhemTopTradersStore })`. The file loader refuses a symlink or
non-regular path (also where `O_NOFOLLOW` is unavailable), binds the opened
descriptor to the inspected file, reads at most 16 MiB, validates before
serving, and closes its descriptor in `finally`. It performs no writes/reloads
or network access. Limits are 10,000 boards and 10,000 traders per board. The
constructed store owns its data; callers cannot mutate it through input or
returned objects. No dependency or lockfile change is needed.

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

Based on main `04be15f61e66d27282e2af3d581de984389eac90`. Before the change,
Fastify `inject` returned `501` for the documented route. With an explicit
synthetic snapshot, the new handler returns a schema-checked `200`; without
one it still returns `501` or the explicit fixture.

From `app/packages/backend`:

```sh
node --import tsx --test test/mayhem-top-traders.test.ts
node --import tsx --test test/*.test.ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc -p tsconfig.json
./node_modules/.bin/tsc --noEmit --strict --target ES2022 --module NodeNext \
  --moduleResolution NodeNext --esModuleInterop --resolveJsonModule \
  --skipLibCheck --types node test/mayhem-top-traders.test.ts
```

All focused requests use in-process `Fastify.inject` and synthetic identifiers.
This is not an aggregate application/browser/evidence-gate pass, nor a
production differential test. No backend compatibility count, feature
milestone, native mayhem parity, security guarantee, or Slop workflow
completion is claimed.
