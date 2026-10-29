# Opt-in local user achievement unlocks and progress

`GET /v1/users/{address}/achievements` now has an independently implemented,
opt-in read model for supplied achievement unlocks and track progress. Without
`userAchievementsStore` / `USER_ACHIEVEMENTS_FILE`, the existing explicit
fixture replay or `501 COMPATIBILITY_NOT_IMPLEMENTED` remains. No synthetic
data is enabled by default. This does not implement achievement rules, grant
evaluation, population snapshots, evidence derivation, the catalog route,
badge overlays (`POST /achievements/overlays`), acknowledgement
(`POST /users/achievements/seen`), a production proxy, or a
native-compatible achievements service.

## Declared source, not recovered backend code

- Developer operation `GET /users/{address}/achievements`, scope
  `profiles.read`, declared origin `https://api.pump.fun/v1`. Website service
  binding remains unresolved.
- OpenAPI 0.294.0: `contracts/developer.openapi.json`, SHA-256
  `ad2fdc2bbf0b86d92e01f539ca609fff8164fcc44556bb2691378a869f73ad73`.
  Its strict success schema is checked against real in-process responses.
- `contracts/developer-bindings.json` binds the route to raw source
  `evidence/web/objects/2b47dd0b38a1608f.js` (507,700 bytes, SHA-256
  `e78d2f38b06f971847c18dd05457c75afc85208135f50d6e4022a5f197e8839d`).
  The route declaration is UTF-16 range `[419546, 420273)`, which hashes to
  `79f133035bf435d72eff0707645a28298191da9ef4f6d43d97f32039dad0cffd`; the
  unlock, evidence and progress schemas it references are range
  `[410637, 414076)`, which hashes to
  `62ba3fa2189095310482d1945eda5f4a48c1fd2323436e891580916e5505fecf`.
  Tests read/hash this text; they never import or execute captured code.

The declared contract establishes: an `address` path parameter and **no query
parameters**; unlocks "ordered by catalog sortOrder" with a nullable ISO-8601
grant time, a nullable frozen metric value, a viewer-relative `seen` that is
"absent on the API host" and "always false for anonymous and third-party
viewers", a nullable population (`holderCount` "never below 1 for a holder",
`holderPercent` 0-100 and "null whenever holderCount is"), and nullable
evidence whose `kind` names the populated arm: a callout (UUID, whole-number
peak multiple, nullable call and peak times) or closed leaderboard finishes
(ISO week `2026-W37` or month `2026-08` labels, 1-based ranks, nullable UTC
period start at Monday 00:00 or the 1st, chronological, never empty);
progress rows whose next and previous tiers are each null exactly when the
track is maxed out or not started; and a `catalogVersion` that is empty only
for a degraded fallback.

The pinned OpenAPI omits the captured descriptions' newer "null when cc served
none" notes; nullability is identical, and the pinned descriptions are
followed.

## Explicit local input and policies

`UserAchievementsDataset` in `src/user-achievements-store.ts` is a **local
schema**, not an upstream database schema. A caller supplies the catalog the
unlocks were resolved against (its version and achievement ids in sortOrder)
and, per address, the already-granted unlocks and current progress. The
producer is responsible for rules, grants, populations, evidence, progress and
authorized local data. The read model does not compute them or accept
ingestion through HTTP.

- Unlocks must name catalog ids, at most once each, in strictly increasing
  catalog order, and are served in that order. Progress is served in supplied
  order with one row per metric.
- `seen` is never supplied: the API host has no signed-in owner, so every
  unlock is served with `seen: false`.
- `catalogVersion` must be non-empty; a supplied dataset is never a degraded
  fallback.
- Times are canonical UTC millisecond strings (`Date#toISOString`) no later
  than `observedAt`. A callout's peak may not precede its call.
- `holderCount` is null or a positive integer; `holderPercent` is null or in
  `[0, 100]` and requires a `holderCount`.
- Evidence populates exactly the arm its `kind` names. Callout ids are UUIDs;
  multiples are positive integers. Each finish's label must be a real ISO week
  (week 53 only in years that have one) or calendar month, its period must
  have closed by `observedAt`, a supplied `periodStart` must equal the derived
  period start, and finishes are chronological by period start without
  repeats. The rule's own cap is not known locally and is not checked.
- Progress names a next or previous tier exactly when it gives that tier's
  threshold; both must be catalog ids, distinct, with the previous threshold
  below the next. `currentValue` is any finite number and is not compared
  with the thresholds, since live values may lag or lead grants.
- A supplied address with no unlocks is a `200` with empty arrays. An address
  without supplied facts returns `501` with `USER_ACHIEVEMENTS_UNAVAILABLE`,
  never fabricated empty achievements. Addresses match exactly; there is no
  case folding or wallet/user-id resolution.
- Any query key, including an empty one, receives local `400 INVALID_QUERY`.
- Malformed or extra fields reject the dataset at startup. Responses identify
  their data source and observation timestamp and explicitly set
  `X-Reconstruction-Compatibility: unqualified`.

The existing developer API-key **shape-only compatibility gate** still runs
before this route. It does not verify credentials, checksums, scopes,
revocation, rate limits or ownership. No new credential path is added.

## Optional startup configuration

Set server-only `USER_ACHIEVEMENTS_FILE` to an explicit local UTF-8 JSON file,
or inject `new UserAchievementsStore(dataset)` into
`buildApp([], { userAchievementsStore })`. The file loader refuses a symlink
or non-regular path (also where `O_NOFOLLOW` is unavailable), binds the opened
descriptor to the inspected file, reads at most 16 MiB, validates before
serving, and closes its descriptor in `finally`. It performs no
writes/reloads or network access. Limits are 1,000 catalog ids, 10,000 users,
and 1,000 finishes per unlock. The constructed store owns its data; callers
cannot mutate it through input or returned objects. No dependency or lockfile
change is needed.

Minimal deliberately empty **synthetic** inventory (not a production fixture):

```json
{
  "schemaVersion": 1,
  "dataSource": "synthetic",
  "observedAt": "2026-10-29T00:00:00.000Z",
  "catalog": { "version": "synthetic-catalog", "order": [] },
  "users": {}
}
```

## Verification and remaining limits

Based on main `2c8a7900f240c8a50cccc2b4d263bdbd32a68924`. Before the change, Fastify `inject` returned `501`
for the documented route. With explicit synthetic facts, the new handler
returns a schema-checked `200`; without them it still returns `501` or the
explicit fixture.

From `app/packages/backend`:

```sh
node --import tsx --test test/user-achievements.test.ts
node --import tsx --test test/*.test.ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc -p tsconfig.json
./node_modules/.bin/tsc --noEmit --strict --target ES2022 --module NodeNext \
  --moduleResolution NodeNext --esModuleInterop --resolveJsonModule \
  --skipLibCheck --types node test/user-achievements.test.ts
```

All focused requests use in-process `Fastify.inject` and synthetic identifiers.
This is not an aggregate application/browser/evidence-gate pass, nor a
production differential test. No backend compatibility count, feature
milestone, native achievements parity, security guarantee, or Slop workflow
completion is claimed.
