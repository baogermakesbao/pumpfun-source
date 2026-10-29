# Opt-in local achievement badge overlays

`POST /v1/achievements/overlays` now has an independently implemented, opt-in
read model for supplied avatar badge overlays. Without
`achievementOverlaysStore` / `ACHIEVEMENT_OVERLAYS_FILE`, the existing
`501 COMPATIBILITY_NOT_IMPLEMENTED` remains (fixture replay covers only GET and
HEAD). No synthetic data is enabled by default. This does not implement badge
selection or ranking, unlock lookup, wallet/user-id resolution, the catalog
route, per-user achievements, a production proxy, or a native-compatible
achievements service.

## Declared source, not recovered backend code

- Developer operation `POST /achievements/overlays`, scope `profiles.read`,
  declared origin `https://api.pump.fun/v1`. Website service binding remains
  unresolved.
- OpenAPI 0.294.0: `contracts/developer.openapi.json`, SHA-256
  `ad2fdc2bbf0b86d92e01f539ca609fff8164fcc44556bb2691378a869f73ad73`.
  It declares a required `ids` array of 1-100 strings of at most 64
  characters and a `201` map schema, which is checked against real in-process
  responses.
- `contracts/developer-bindings.json` binds the route to raw source
  `evidence/web/objects/2b47dd0b38a1608f.js` (507,700 bytes, SHA-256
  `e78d2f38b06f971847c18dd05457c75afc85208135f50d6e4022a5f197e8839d`).
  The route declaration is UTF-16 range `[39484, 39939)`, which hashes to
  `7b4d99187f4dea55302bfbba79112f71b3aba557730ac10cd523e0ee9355d3a2`.
  Tests read/hash this text; they never import or execute captured code.

The declared contract establishes: **no query parameters**; a body of `ids`,
"Wallet addresses (Solana base58 or EVM 0x) or user ids (UUID), disambiguated
by format"; and a `201` response mapping each requested id to its badge ids,
where "ids with no unlocks are an empty array". It does not declare how many
badges are "top", how they are chosen or ordered, or what happens to an id of
neither format.

## Explicit local input and policies

`AchievementOverlaysDataset` in `src/achievement-overlays-store.ts` is a
**local schema**, not an upstream database schema. Per wallet address or user
id, a caller supplies the already-selected top badge ids in display order. The
producer is responsible for selection, ranking, unlock truth, id resolution
and authorized local data. The read model does not compute them or accept
ingestion through HTTP.

- Each `id` must be one of the declared formats: Solana base58 of 32-44
  characters, `0x` followed by 40 hex digits, or a UUID. Anything else, an
  empty or over-100 list, a non-array `ids`, or any other body key receives
  local `400 INVALID_BODY`. Any query key, including an empty one, receives
  local `400 INVALID_QUERY`. A body that is not valid JSON keeps Fastify's own
  `400` before the route runs.
- Badges are served in supplied order. Each list holds at most 100 unique,
  non-empty badge ids of at most 64 characters. A supplied empty list is
  served as the declared empty array for an id with no unlocks.
- The batch is all-or-nothing: if any requested id has no supplied overlay,
  the request returns `501` with `ACHIEVEMENT_OVERLAYS_UNAVAILABLE`, never a
  fabricated empty array. Ids match exactly: EVM checksum case and UUID case
  are not folded, and a wallet is not resolved to its user id or back.
- The response holds each requested id once, in request order, and returns
  `201` as declared.
- Malformed or extra fields reject the dataset at startup. Responses identify
  their data source and observation timestamp and explicitly set
  `X-Reconstruction-Compatibility: unqualified`.

The existing developer API-key **shape-only compatibility gate** still runs
before this route. It does not verify credentials, checksums, scopes,
revocation, rate limits or ownership. No new credential path is added.

## Optional startup configuration

Set server-only `ACHIEVEMENT_OVERLAYS_FILE` to an explicit local UTF-8 JSON
file, or inject `new AchievementOverlaysStore(dataset)` into
`buildApp([], { achievementOverlaysStore })`. The file loader refuses a
symlink or non-regular path (also where `O_NOFOLLOW` is unavailable), binds
the opened descriptor to the inspected file, reads at most 16 MiB, validates
before serving, and closes its descriptor in `finally`. It performs no
writes/reloads or network access. The limit is 100,000 ids. The constructed
store owns its data; callers cannot mutate it through input or returned
objects. No dependency or lockfile change is needed.

Minimal deliberately empty **synthetic** inventory (not a production fixture):

```json
{
  "schemaVersion": 1,
  "dataSource": "synthetic",
  "observedAt": "2026-10-29T00:00:00.000Z",
  "overlays": {}
}
```

## Verification and remaining limits

Based on main `630a074126a13d4133514d599129c6ac9a3179bc`. Before the change, Fastify `inject` returned `501`
for the documented route. With explicit synthetic overlays, the new handler
returns a schema-checked `201`; without them it still returns `501`.

From `app/packages/backend`:

```sh
node --import tsx --test test/achievement-overlays.test.ts
node --import tsx --test test/*.test.ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc -p tsconfig.json
./node_modules/.bin/tsc --noEmit --strict --target ES2022 --module NodeNext \
  --moduleResolution NodeNext --esModuleInterop --resolveJsonModule \
  --skipLibCheck --types node test/achievement-overlays.test.ts
```

All focused requests use in-process `Fastify.inject` and synthetic identifiers.
This is not an aggregate application/browser/evidence-gate pass, nor a
production differential test. No backend compatibility count, feature
milestone, native achievements parity, security guarantee, or Slop workflow
completion is claimed.
