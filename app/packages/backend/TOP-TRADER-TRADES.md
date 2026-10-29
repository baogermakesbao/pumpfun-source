# Opt-in local top-trader trades

`GET /v1/pnl-leaderboard/top-trader-trades/{mint}` now has an independently
implemented, opt-in read model for supplied top-trader trades. Without
`topTraderTradesStore` / `TOP_TRADER_TRADES_FILE`, the existing explicit fixture
replay or `501 COMPATIBILITY_NOT_IMPLEMENTED` remains. No synthetic trades are
enabled by default. This does not implement leaderboard building, rank
computation, wallet linking, trade ingestion, chart rendering, sessions, a
production proxy, or a native-compatible leaderboard service.

## Declared source, not recovered backend code

- Developer operation `GET /pnl-leaderboard/top-trader-trades/{mint}`, scope
  `leaderboards.read`, declared origin `https://api.pump.fun/v1`. Website
  service binding remains unresolved.
- OpenAPI 0.294.0: `contracts/developer.openapi.json`, SHA-256
  `ad2fdc2bbf0b86d92e01f539ca609fff8164fcc44556bb2691378a869f73ad73`.
  Its strict success schema is checked against real in-process responses.
- `contracts/developer-bindings.json` binds the route to raw source
  `evidence/web/objects/2b47dd0b38a1608f.js` (507,700 bytes, SHA-256
  `e78d2f38b06f971847c18dd05457c75afc85208135f50d6e4022a5f197e8839d`).
  The route declaration is UTF-16 range `[312224, 314130)`, which hashes to
  `c1b45e8a93e62ad290d36cbf204942c491fa02c9b4753879bf24d4e237d56c22`; the
  shared trader/trade row contracts are `[303352, 305280)`, hashing to
  `5123e8043098d65c3303cfee4c281910d6cc411ddf1d293d74cb91c1b7f5f6b6`.
  Tests read/hash this text; they never import or execute captured code.

The declared contract establishes: trades of a coin by accounts ranked in the
top 50 of any period, across all their wallets on either chain; an optional
`chainId`; `to` serving trades at or before an epoch-ms instant; an opaque
`cursor` continuing from `page.nextCursor`; `limit` trades per page with
default and ceiling 500 (minimum 1); `page: null` meaning the whole set; and
per trader the `tradingWallets` that traded the coin, `tradeCount`, best rank
and the periods ranked in.

## Explicit local input and policies

`TopTraderTradesDataset` in `src/top-trader-trades-store.ts` is a **local
schema**, not an upstream database schema. A caller supplies the already-built
top traders (best rank 1..50, non-empty ranked periods), their trades with the
twelve declared trade fields, board/generation times and an observation
timestamp. The producer is responsible for ranking, wallet linking and
authorized local data. The read model does not compute boards or accept
ingestion through HTTP.

- Trades are served newest first by `slotIndexId`, a local fixed-width
  26-digit chain-order key that must be unique. Timestamps, when present, may
  not be later than `observedAt` and may not run against slot order.
- `traders` are built only from the served trades: distinct `tradingWallets`
  in exact code-unit order, `tradeCount` of served trades, ordered by best rank
  then a **local** `userId` order. Every trade must belong to a supplied trader.
- `page` is `null` only when no `to`, `cursor` or `limit` was given and all
  trades fit under the 500 ceiling; otherwise the server pages, echoing
  `to` (or `null`) and the effective `limit`. A larger set is never served as a
  truncated whole set.
- The cursor format `s:<slotIndexId>` (strictly older than that slot) is
  local and opaque to clients. Under `to`, undated trades are not served.
- An omitted `chainId` for a mint whose supplied trades span more than one
  chain returns `501` with `MINT_CHAIN_INFERENCE_UNAVAILABLE`, never a guessed
  chain. A coin without supplied trades is an empty whole set.
- `generatedAtMs` may not precede `boardsBuiltAtMs`. Malformed or extra fields
  reject the dataset at startup.
- Canonical decimal integer syntax is a local policy. Unknown or repeated query
  keys, an unparsable cursor, and out-of-range or non-integer values receive
  local `400 INVALID_QUERY`.
- Responses identify their data source and observation timestamp and
  explicitly set `X-Reconstruction-Compatibility: unqualified`.

The existing developer API-key **shape-only compatibility gate** still runs
before this route. It does not verify credentials, checksums, scopes,
revocation, rate limits or ownership. No new credential path is added.

## Optional startup configuration

Set server-only `TOP_TRADER_TRADES_FILE` to an explicit local UTF-8 JSON file,
or inject `new TopTraderTradesStore(dataset)` into
`buildApp([], { topTraderTradesStore })`. The file loader opens only a regular
non-symlink file, reads at most 16 MiB, validates before serving, and closes
its descriptor in `finally`. It performs no writes/reloads or network access.
Limits are 10,000 traders and 200,000 trades. The constructed store owns its
data; callers cannot mutate it through input or returned objects. No
dependency or lockfile change is needed.

Minimal deliberately empty **synthetic** inventory (not a production fixture):

```json
{
  "schemaVersion": 1,
  "dataSource": "synthetic",
  "observedAt": "2026-10-29T00:00:00.000Z",
  "boardsBuiltAtMs": 0,
  "generatedAtMs": 0,
  "traders": [],
  "trades": []
}
```

## Verification and remaining limits

Based on main `5d95432196afb3b708a111799c642e8d35bb9e84`. Before the change,
Fastify `inject` returned `501` for the documented route. With explicit
synthetic trades, the new handler returns a schema-checked `200`; without them
it still returns `501` or the explicit fixture.

From `app/packages/backend`:

```sh
node --import tsx --test test/top-trader-trades.test.ts
node --import tsx --test test/*.test.ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc -p tsconfig.json
./node_modules/.bin/tsc --noEmit --strict --target ES2022 --module NodeNext \
  --moduleResolution NodeNext --esModuleInterop --resolveJsonModule \
  --skipLibCheck --types node test/top-trader-trades.test.ts
```

All focused requests use in-process `Fastify.inject` and synthetic identifiers.
This is not an aggregate application/browser/evidence-gate pass, nor a
production differential test. No backend compatibility count, feature
milestone, native leaderboard parity, security guarantee, or Slop workflow
completion is claimed.
