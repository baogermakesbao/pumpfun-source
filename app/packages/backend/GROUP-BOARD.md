# Opt-in local group PnL leaderboard

`GET /v1/pnl-leaderboard/groups` now has an independently implemented, opt-in
read model for supplied group board rows. Without `groupBoardStore` /
`GROUP_BOARD_FILE`, the existing explicit fixture replay or
`501 COMPATIBILITY_NOT_IMPLEMENTED` remains. No synthetic board is enabled by
default. This does not implement PnL folding, member aggregation, board bans
(`POST /pnl-leaderboard/groups/ban`), group competitions, viewer fields,
sessions, a production proxy, or a native-compatible leaderboard service.

## Declared source, not recovered backend code

- Developer operation `GET /pnl-leaderboard/groups`, scope `leaderboards.read`,
  declared origin `https://api.pump.fun/v1`. Website service binding remains
  unresolved.
- OpenAPI 0.294.0: `contracts/developer.openapi.json`, SHA-256
  `ad2fdc2bbf0b86d92e01f539ca609fff8164fcc44556bb2691378a869f73ad73`.
  Its strict success schema is checked against real in-process responses.
- `contracts/developer-bindings.json` binds the route to raw source
  `evidence/web/objects/2b47dd0b38a1608f.js` (507,700 bytes, SHA-256
  `e78d2f38b06f971847c18dd05457c75afc85208135f50d6e4022a5f197e8839d`).
  The PnL leaderboard route module through this operation is UTF-16 range
  `[303179, 310781)`, which hashes to
  `75906f46d487bd0c82183d8ce2b053ad70de4c71c40ece8f5d244f47bbe4670d`.
  Tests read/hash this text; they never import or execute captured code.

The declared contract establishes: a required `daily`/`weekly`/`monthly`
period; an optional `realized`/`unrealized`/`combined` sort; `limit` rows with
default and ceiling 100, out-of-range values clamping; `positionsLimit` icons
per row, default 3, values above 5 clamping to 5 and 0 meaning count only;
`positionsCount` as the whole holdings count, never sliced; top positions
largest fresh USD value first; and the numeric `periodType` codes
`0 unspecified, 1 weekly, 2 monthly, 3 daily`.

The captured module also declares `xUsername` and `activeCompetitionEntry` per
row, absent from OpenAPI 0.294.0's `additionalProperties: false` row schema.
This developer route deliberately follows the pinned OpenAPI and omits them, as
`PAYOUTS.md` does for its newer field. It does not silently broaden the schema.

## Explicit local input and policies

`GroupBoardDataset` in `src/group-board-store.ts` is a **local schema**, not an
upstream database schema. A caller supplies, per period, a complete board of
already-folded group rows plus the period label and window start, and an
observation timestamp. The producer is responsible for folding, member
counting, ban exclusion and authorized local data. The read model does not
compute PnL, fetch profiles or accept ingestion through HTTP.

- `combined` (the default) ranks on `pnlUsd`, `realized` on `realizedPnlUsd`,
  `unrealized` on `unrealizedPnlUsd`, descending; ranks are one-based on the
  chosen measure. Equal measures use a **local** exact code-unit `groupId`
  order. `totalRanked` counts the whole supplied board, before the row limit.
- Negative row limits clamp to an empty page; that lower bound is local. The
  `positionsLimit` schema minimum of 0 is enforced, so negatives are `400`.
- Each position carries a local `valueUsd` used only for the declared ordering
  and never served. Equal values use a local mint, then chain, order.
- `periodLabel` and `windowStartSec` are supplied, never guessed. A valid period
  without a supplied board returns `501` with `GROUP_BOARD_UNAVAILABLE`, never
  another period's board.
- Rows must be unique per group, `membersCounted` may not exceed `memberCount`,
  measures must be finite, and refresh and window times may not be later than
  `observedAt`. Malformed or extra fields reject the dataset at startup.
- Canonical decimal integer syntax is a local policy. Unknown or repeated query
  keys, an unknown sort, and non-integer values receive local
  `400 INVALID_QUERY`. The sibling `GET /pnl-leaderboard` falls back on an
  unknown sort; this route does not follow that leniency.
- Responses identify their data source and observation timestamp and
  explicitly set `X-Reconstruction-Compatibility: unqualified`.

The existing developer API-key **shape-only compatibility gate** still runs
before this route. It does not verify credentials, checksums, scopes,
revocation, rate limits or ownership. No new credential path is added.

## Optional startup configuration

Set server-only `GROUP_BOARD_FILE` to an explicit local UTF-8 JSON file, or
inject `new GroupBoardStore(dataset)` into `buildApp([], { groupBoardStore })`.
The file loader opens only a regular non-symlink file, reads at most 16 MiB,
validates before serving, and closes its descriptor in `finally`. It performs
no writes/reloads or network access. Limits are 10,000 rows per board and
1,000 positions per row. The constructed store owns its data; callers cannot
mutate it through input or returned objects. No dependency or lockfile change
is needed.

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

Based on main `665499915f9caedcd38921d415a90f0606686398`. Before the change,
Fastify `inject` returned `501` for the documented route. With explicit
synthetic rows, the new handler returns a schema-checked `200`; without them it
still returns `501` or the explicit fixture.

From `app/packages/backend`:

```sh
node --import tsx --test test/group-board.test.ts
node --import tsx --test test/*.test.ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc -p tsconfig.json
./node_modules/.bin/tsc --noEmit --strict --target ES2022 --module NodeNext \
  --moduleResolution NodeNext --esModuleInterop --resolveJsonModule \
  --skipLibCheck --types node test/group-board.test.ts
```

All focused requests use in-process `Fastify.inject` and synthetic identifiers.
This is not an aggregate application/browser/evidence-gate pass, nor a
production differential test. No backend compatibility count, feature
milestone, native leaderboard parity, security guarantee, or Slop workflow
completion is claimed.
