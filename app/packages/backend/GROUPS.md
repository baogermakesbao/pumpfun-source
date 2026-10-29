# Opt-in local group members and member PnL

`GET /v1/groups/{groupId}/members` and `GET /v1/groups/{groupId}/members/pnl`
now have an independently implemented, opt-in read model for supplied group
facts. Without `groupsStore` / `GROUPS_FILE`, the existing explicit fixture
replay or `501 COMPATIBILITY_NOT_IMPLEMENTED` remains. No synthetic groups are
enabled by default. This does not implement group creation, invites, role
changes, removal, search, `GET /groups/me`, `GET /groups/of/{id}`, the group
PnL leaderboard, PnL folding, competitions, sessions, a production proxy, or a
native-compatible groups service.

## Declared source, not recovered backend code

- Developer operations `GET /groups/{groupId}/members` and
  `GET /groups/{groupId}/members/pnl`, scope `graph.read`, declared origin
  `https://api.pump.fun/v1`. Website service binding remains unresolved.
- OpenAPI 0.294.0: `contracts/developer.openapi.json`, SHA-256
  `ad2fdc2bbf0b86d92e01f539ca609fff8164fcc44556bb2691378a869f73ad73`.
  Both strict success schemas are checked against real in-process responses,
  and every supplied member profile is checked against the declared closed
  profile schema at startup.
- `contracts/developer-bindings.json` binds both routes to raw source
  `evidence/web/objects/2b47dd0b38a1608f.js` (507,700 bytes, SHA-256
  `e78d2f38b06f971847c18dd05457c75afc85208135f50d6e4022a5f197e8839d`).
  The groups route module is UTF-16 range `[221848, 226482)`, which hashes to
  `f868abde4e8b2b3e762b230a2c129182778e78a23e390def0f746e8b731eec1c`.
  Tests read/hash this text; they never import or execute captured code.

The declared contract establishes: members are paged owner first; the INVITED
view is owner/admin-only; `status` is optional (`INVITED`/`ACTIVE`, omitted
matches every status); `limit` 1–200 and `offset` ≥ 0; role and status are
upstream open enums (`OWNER`/`ADMIN`/`MEMBER`/`UNSPECIFIED`,
`INVITED`/`ACTIVE`/`UNSPECIFIED`); `invitedBy` is null when the inviter was
deleted and `createdAt` is the invite time, unchanged by acceptance. Member PnL
takes a required `1d`/`1w`/`1m` period and serves active members with a counted
fold row, `pnlUsd` descending; `builtAtMs` is 0 when no fold is published, and
the last published board is served for up to 15 minutes.

The captured module also declares a per-member `inCompetition` boolean, absent
from OpenAPI 0.294.0's `additionalProperties: false` member schema. This
developer route deliberately follows the pinned OpenAPI and omits it, as the
payout route does for its newer field. It does not silently broaden the schema.

## Explicit local input and policies

`GroupsDataset` in `src/groups-store.ts` is a **local schema**, not an upstream
database schema. A caller supplies every group's member rows, per-period PnL
folds, explicit window starts and an observation timestamp. The producer is
responsible for membership truth, folding and authorized local data. The read
model does not compute PnL, discover identities, fetch profiles, or accept
ingestion through HTTP.

- Roles and statuses must be one of the known declared values; anything else
  fails startup rather than being served or silently mapped to `UNSPECIFIED`.
  At most one `OWNER`, and the owner must be `ACTIVE`. Member identity is the
  supplied `profile.userId`, unique per group; a deleted account is a
  `profile: null` row.
- Owner first is declared. The order after the owner is the producer's supplied
  order; no upstream ordering of other members is established.
- The INVITED view needs an owner/admin viewer and this host has no viewer, so
  `status=INVITED`, and an unfiltered read of a group that has INVITED rows,
  return `501` with `INVITED_VIEW_REQUIRES_GROUP_ROLE` instead of exposing or
  silently dropping invites. Unfiltered groups without invites and
  `status=ACTIVE` are served.
- Default `limit` 50 is a local policy; the 1–200 range follows OpenAPI.
  `hasMore` is true when rows remain after the page. Distant valid offsets
  return an empty page. Duplicate/unknown query keys and non-canonical values
  receive local `400 INVALID_QUERY`. An unknown group is a local
  `404 GROUP_NOT_FOUND`.
- Each fold row must name an `ACTIVE` member with a profile, folded for that
  profile's `walletAddress`; rows are unique per member and `pnlUsd` must be
  finite. Equal PnL uses a **local** exact code-unit `userId` order.
- Window starts are supplied per period; no wall clock or guessed rolling
  duration is used. A valid period without a supplied window returns `501`
  with `GROUP_PNL_WINDOW_UNAVAILABLE`. A fold must be built inside its window
  and no later than `observedAt`. A group without a fold, or whose fold is more
  than 15 minutes older than `observedAt`, serves `builtAtMs: 0` and empty
  rows. Measuring the 15 minutes against `observedAt` is a local interpretation.
- Responses identify their data source and observation timestamp and
  explicitly set `X-Reconstruction-Compatibility: unqualified`.

The existing developer API-key **shape-only compatibility gate** still runs
before these routes. It does not verify credentials, checksums, scopes,
revocation, rate limits or ownership. No new credential path is added.

## Optional startup configuration

Set server-only `GROUPS_FILE` to an explicit local UTF-8 JSON file, or inject
`new GroupsStore(dataset)` into `buildApp([], { groupsStore })`. The file loader
opens only a regular non-symlink file, reads at most 16 MiB, validates before
serving, and closes its descriptor in `finally`. It performs no writes/reloads
or network access. Limits are 10,000 groups and 1,000 members or fold rows per
group. The constructed store owns its data; callers cannot mutate it through
input or returned objects. No dependency or lockfile change is needed.

Minimal deliberately empty **synthetic** inventory (not a production fixture):

```json
{
  "schemaVersion": 1,
  "dataSource": "synthetic",
  "observedAt": "2026-10-29T00:00:00.000Z",
  "pnlWindows": {},
  "groups": []
}
```

## Verification and remaining limits

Based on main `665499915f9caedcd38921d415a90f0606686398`. Before the change,
Fastify `inject` returned `501` for both documented routes. With explicit
synthetic facts, the new handlers return schema-checked `200`s; without them
they still return `501` or the explicit fixture.

From `app/packages/backend`:

```sh
node --import tsx --test test/groups.test.ts
node --import tsx --test test/*.test.ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc -p tsconfig.json
./node_modules/.bin/tsc --noEmit --strict --target ES2022 --module NodeNext \
  --moduleResolution NodeNext --esModuleInterop --resolveJsonModule \
  --skipLibCheck --types node test/groups.test.ts
```

All requests use in-process `Fastify.inject` and synthetic identifiers; no
listener or external service is required. This is not an aggregate
application/browser/evidence-gate pass, nor a production differential test. No
backend compatibility count, feature milestone, native groups parity, security
guarantee, or Slop workflow completion is claimed.
