# Opt-in local portfolio summary

`GET /v1/portfolio-summary` now has an independently implemented, opt-in read
model for supplied, precomputed portfolio PnL bodies. Without
`portfolioSummaryStore` / `PORTFOLIO_SUMMARY_FILE`, the existing explicit
fixture replay or `501 COMPATIBILITY_NOT_IMPLEMENTED` remains. No synthetic
summary is enabled by default. This does not implement a PnL engine, pricing or
repricing, linked-wallet or username resolution, NEAR/Starknet legs, squad
aggregation, owner refresh, caching, a production proxy, or a native-compatible
portfolio service. `POST /portfolio-summary/balances` and
`GET /portfolio-summary/chart` are unchanged.

## Declared source, not recovered backend code

- Developer operation `GET /portfolio-summary`, scope `positions.read`,
  declared origin `https://api.pump.fun/v1`. Website service binding remains
  unresolved.
- OpenAPI 0.294.0: `contracts/developer.openapi.json`, SHA-256
  `ad2fdc2bbf0b86d92e01f539ca609fff8164fcc44556bb2691378a869f73ad73`.
  Its strict wallet and group response arms validate every supplied body at
  startup; tests validate every in-process response against the full `200`
  schema and the `API_USER_REQUIRED` reply against the `400` schema.
- `contracts/developer-bindings.json` binds the route to raw source
  `evidence/web/objects/2b47dd0b38a1608f.js` (507,700 bytes, SHA-256
  `e78d2f38b06f971847c18dd05457c75afc85208135f50d6e4022a5f197e8839d`).
  The factory's schemas and the route declaration are UTF-16 range
  `[316171, 329162)`, which hashes to
  `083b87cb8275075285c47251672d79b06bc8db86196f12885a713f6a34134ad0`.
  Tests read/hash this text and check the phrases below; they never import or
  execute captured code.

The declared contract establishes:

- Query `user` (at most 66 characters; "omitted with an API key answers 400
  API_USER_REQUIRED"), required `period` (`1d`, `1w`, `1m`, `all`), optional
  `periods` (at most 15 characters matching
  `^(1d|1w|1m|all)(,(1d|1w|1m|all))*$`, "duplicates collapsed, order kept"),
  and the booleans `fresh` and `holdings` ("1/true").
- The response is the wallet arm or, for "a group id or group username", the
  squad aggregate arm.
- `windows`: one entry per requested period; "null = that window was refused
  or failed, never zero legs. The `period` entry equals the top-level legs."
- `holdings`: the balance leg's top 25 rows, N = `reprice.depth`; omitted
  holdings means no `holdings` key; null = unavailable. `reprice` is present
  only when holdings is sent; null = holdings unavailable.
- `fresh` "applies only to a signed-in owner … Anyone else, every API-host
  caller included, is served the cached body", whose `cache.fresh` is absent.
- `tokenCount` is null only when "the balance leg serves alone (every PnL leg
  null, totalValueUsd served)".
- `markSource` is "null exactly when markUsd is null"; `reprice.reason` is null
  when the reprice ran and `plane` `none` means it did not; `unrepriced` holds
  up to 50 rows; an `identity` bucket "the server cannot compute is null with a
  reason, never 0" (including `tailValueUsd`).
- "a NEAR account id or Starknet address answers all with null pnl and
  realizedPnl"; `evmAddress` is the linked wallet "lowercased 0x".

The contract does not declare the units of `from`/`to`, the length of each
window, or how a username or linked EVM wallet resolves. None of these is
inferred or checked.

## Explicit local input and policies

`PortfolioSummaryDataset` in `src/portfolio-summary-store.ts` is a **local
schema**, not an upstream database schema. Each subject is keyed by the exact
`user` value it answers and has a `kind` (`wallet` or `group`) and a body per
materialized period; an explicit `null` records a failed window. The producer
is responsible for PnL, prices, linked wallets, identity resolution and
authorized local data. The read model does not compute them or accept
ingestion through HTTP.

- Lookup is exact: no case folding, username or EVM resolution. At most 10,000
  subjects; keys are 1–66 characters.
- A body must match its kind's response arm exactly. Wallet bodies may not
  carry `windows`: the store builds it from the subject's own period bodies, so
  each entry is the 12 window keys of that period and the `period` entry always
  equals the top-level legs. A failed window is served `null`. If the top-level
  period, or any requested window, was never materialized, the read answers
  `501` (`PORTFOLIO_SUMMARY_UNAVAILABLE`) rather than serving a partial body.
  A top-level `null` also answers `501`.
- `holdings` and `reprice` are removed unless `holdings` is `1`/`true`. When it
  is sent and a body has no holdings, `holdings: null` is served and no rows
  are invented. Groups carry neither key, nor `windows`.
- `fresh` is accepted and ignored. `cache.fresh` may not be supplied at all.
- Every window of one subject must name the same `wallet` (or `groupId`).
- `from` may not follow `to`. `cache.filledAtMs`, `computedAt` and
  `reprice.asOf` (all declared epoch milliseconds) may not follow
  `observedAt`, and `ttlSeconds` is non-negative.
- The declared invariants above are enforced. In addition: `tokenCount`,
  `reprice.depth`, `memberCount` and `membersIncluded` are non-negative
  integers, and a Starknet address is recognized as `0x` plus 64 hex digits
  in either case. NEAR account ids are not recognized, so their `all` rule is
  the producer's responsibility.
- Query keys other than the five declared ones, repeated keys, an empty or
  over-long `user`, and values outside the declared forms receive local
  `400 INVALID_QUERY`. These checks run before the user requirement. A call
  without `user` receives the declared `400 API_USER_REQUIRED` envelope, since
  there is no session principal here.
- Malformed datasets fail at startup. Responses identify their data source and
  observation timestamp and explicitly set
  `X-Reconstruction-Compatibility: unqualified`.

The existing developer API-key **shape-only compatibility gate** still runs
before this route. It does not verify credentials, checksums, scopes,
revocation, rate limits or ownership. No new credential path is added.

## Optional startup configuration

Set server-only `PORTFOLIO_SUMMARY_FILE` to an explicit local UTF-8 JSON file,
or inject `new PortfolioSummaryStore(dataset)` into
`buildApp([], { portfolioSummaryStore })`. The file loader refuses a symlink or
non-regular path (also where `O_NOFOLLOW` is unavailable), binds the opened
descriptor to the inspected file, reads at most 16 MiB, validates before
serving, and closes its descriptor in `finally`. It performs no
writes/reloads or network access. The constructed store keeps serialized
snapshots, so callers cannot mutate it through input or returned objects. No
dependency or lockfile change is needed.

Minimal deliberately empty **synthetic** inventory (not a production fixture):

```json
{
  "schemaVersion": 1,
  "dataSource": "synthetic",
  "observedAt": "2026-10-29T00:00:00.000Z",
  "subjects": {}
}
```

## Verification and remaining limits

Based on main `03fa4494f36449cd8fd63e121f12ca40bf57090f`. Before the change, Fastify `inject` returned `501`
for the documented route. With an explicit synthetic dataset, the new handler
returns a schema-checked `200`; without one it still returns `501` or the
explicit fixture.

From `app/packages/backend`:

```sh
node --import tsx --test test/portfolio-summary.test.ts
node --import tsx --test test/*.test.ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc -p tsconfig.json
./node_modules/.bin/tsc --noEmit --strict --target ES2022 --module NodeNext \
  --moduleResolution NodeNext --esModuleInterop --resolveJsonModule \
  --skipLibCheck --types node test/portfolio-summary.test.ts
```

All focused requests use in-process `Fastify.inject` and synthetic identifiers.
This is not an aggregate application/browser/evidence-gate pass, nor a
production differential test. No backend compatibility count, feature
milestone, native PnL parity, security guarantee, or Slop workflow completion
is claimed.
