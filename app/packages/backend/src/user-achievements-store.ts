import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";

export interface CalloutEvidence {
  calloutId: string;
  mint: string;
  multiple: number;
  calledOutAt: string | null;
  peakedAt: string | null;
}
export interface LeaderboardFinish {
  periodType: "weekly" | "monthly";
  periodLabel: string;
  rank: number;
  periodStart: string | null;
}
export interface AchievementEvidence {
  kind: "callout" | "leaderboard";
  callout: CalloutEvidence | null;
  leaderboard: { finishes: LeaderboardFinish[] } | null;
}
/** Local input: one public unlock fact. `seen` is viewer-relative and never supplied. */
export interface AchievementUnlock {
  achievementId: string;
  unlockedAt: string | null;
  value: number | null;
  holderCount: number | null;
  holderPercent: number | null;
  evidence: AchievementEvidence | null;
}
export interface AchievementProgress {
  metric: string;
  currentValue: number;
  nextThreshold: number | null;
  nextAchievementId: string | null;
  previousThreshold: number | null;
  previousAchievementId: string | null;
}
export interface UserAchievementsDataset {
  schemaVersion: 1;
  dataSource: "synthetic" | "local-materialized";
  observedAt: string;
  /** The catalog the unlocks were resolved against: its version and ids in sortOrder. */
  catalog: { version: string; order: string[] };
  users: Record<string, { achievements: AchievementUnlock[]; progress: AchievementProgress[] }>;
}
export interface UserAchievements {
  achievements: (AchievementUnlock & { seen: boolean })[];
  progress: AchievementProgress[];
  catalogVersion: string;
}
export class UnavailableUserAchievementsError extends Error {}

const UNLOCK_KEYS = ["achievementId", "unlockedAt", "value", "holderCount", "holderPercent", "evidence"] as const;
const PROGRESS_KEYS = [
  "metric", "currentValue", "nextThreshold", "nextAchievementId", "previousThreshold", "previousAchievementId",
] as const;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_CATALOG = 1_000;
const MAX_USERS = 10_000;
const MAX_FINISHES = 1_000;
const DAY_MS = 86_400_000;

function invalid(field: string): never {
  throw new TypeError(`Invalid local user achievements dataset: ${field}`);
}
function plain(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}
function record(value: unknown, keys: readonly string[], field: string) {
  if (!plain(value)) invalid(field);
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    invalid(field);
  return value;
}
function text(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 2048 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    invalid(field);
  return value;
}
function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(field);
  return value;
}
function nullableFinite(value: unknown, field: string): number | null {
  return value === null ? null : finite(value, field);
}
function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(field);
  return value as number;
}
/** Canonical UTC millisecond timestamp, as `Date#toISOString` writes it. */
function instant(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) invalid(field);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) invalid(field);
  return ms;
}
function list(value: unknown, max: number, field: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(field);
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) invalid(field);
  }
  return value;
}

/** UTC start and exclusive end (ms) of an ISO week ("2026-W37") or calendar month ("2026-08"). */
function periodBounds(type: unknown, label: unknown): [number, number] {
  if (type === "monthly") {
    const match = typeof label === "string" ? /^(\d{4})-(0[1-9]|1[0-2])$/.exec(label) : null;
    if (!match) invalid("finish.periodLabel");
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    return [Date.UTC(year, month, 1), Date.UTC(year, month + 1, 1)];
  }
  if (type === "weekly") {
    const match = typeof label === "string" ? /^(\d{4})-W(0[1-9]|[1-4][0-9]|5[0-3])$/.exec(label) : null;
    if (!match) invalid("finish.periodLabel");
    const year = Number(match[1]);
    // ISO week 1 is the week holding 4 January; weeks start on Monday.
    const jan4 = Date.UTC(year, 0, 4);
    const week1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
    const start = week1 + (Number(match[2]) - 1) * 7 * DAY_MS;
    const nextJan4 = Date.UTC(year + 1, 0, 4);
    const nextWeek1 = nextJan4 - ((new Date(nextJan4).getUTCDay() + 6) % 7) * DAY_MS;
    if (start >= nextWeek1) invalid("finish.periodLabel");
    return [start, start + 7 * DAY_MS];
  }
  invalid("finish.periodType");
}

/** Immutable, opt-in read model. No rule evaluation, population counts, viewer state or writes. */
export class UserAchievementsStore {
  readonly dataSource: UserAchievementsDataset["dataSource"];
  readonly observedAt: string;
  readonly #catalogVersion: string;
  readonly #users = new Map<string, { achievements: AchievementUnlock[]; progress: AchievementProgress[] }>();

  constructor(input: unknown) {
    const data = record(input, ["schemaVersion", "dataSource", "observedAt", "catalog", "users"], "root");
    if (
      data.schemaVersion !== 1 ||
      (data.dataSource !== "synthetic" && data.dataSource !== "local-materialized")
    )
      invalid("version/source");
    this.dataSource = data.dataSource;
    const observedAtMs = instant(data.observedAt, "observedAt");
    this.observedAt = data.observedAt as string;

    const catalog = record(data.catalog, ["version", "order"], "catalog");
    // An empty version marks a degraded fallback, which a supplied dataset never is.
    this.#catalogVersion = text(catalog.version, "catalog.version");
    const sortIndex = new Map<string, number>();
    for (const id of list(catalog.order, MAX_CATALOG, "catalog.order")) {
      if (sortIndex.has(text(id, "catalog.order"))) invalid("duplicate catalog id");
      sortIndex.set(id as string, sortIndex.size);
    }
    const catalogId = (value: unknown, field: string): string => {
      if (!sortIndex.has(text(value, field))) invalid(field);
      return value as string;
    };
    const timeBeforeSnapshot = (value: unknown, field: string): number | null => {
      if (value === null) return null;
      const ms = instant(value, field);
      if (ms > observedAtMs) invalid(field);
      return ms;
    };

    const evidence = (value: unknown): AchievementEvidence | null => {
      if (value === null) return null;
      const row = record(value, ["kind", "callout", "leaderboard"], "evidence");
      if (row.kind === "callout") {
        if (row.leaderboard !== null) invalid("evidence.leaderboard");
        const callout = record(row.callout, ["calloutId", "mint", "multiple", "calledOutAt", "peakedAt"], "evidence.callout");
        if (
          typeof callout.calloutId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(callout.calloutId)
        )
          invalid("callout.calloutId");
        const calledOutAt = timeBeforeSnapshot(callout.calledOutAt, "callout.calledOutAt");
        const peakedAt = timeBeforeSnapshot(callout.peakedAt, "callout.peakedAt");
        if (calledOutAt !== null && peakedAt !== null && peakedAt < calledOutAt) invalid("callout.peakedAt");
        return {
          kind: "callout",
          callout: {
            calloutId: callout.calloutId,
            mint: text(callout.mint, "callout.mint"),
            multiple: positiveInteger(callout.multiple, "callout.multiple"),
            calledOutAt: callout.calledOutAt as string | null,
            peakedAt: callout.peakedAt as string | null,
          },
          leaderboard: null,
        };
      }
      if (row.kind !== "leaderboard") invalid("evidence.kind");
      if (row.callout !== null) invalid("evidence.callout");
      const board = record(row.leaderboard, ["finishes"], "evidence.leaderboard");
      const periods = new Set<string>();
      let previousStart = -Infinity;
      const finishes = list(board.finishes, MAX_FINISHES, "leaderboard.finishes").map((value) => {
        const finish = record(value, ["periodType", "periodLabel", "rank", "periodStart"], "finish");
        const [start, end] = periodBounds(finish.periodType, finish.periodLabel);
        const key = `${finish.periodType} ${finish.periodLabel}`;
        if (periods.has(key)) invalid("duplicate finish");
        periods.add(key);
        // Chronological, and only closed periods can carry a finish.
        if (start < previousStart) invalid("finish order");
        previousStart = start;
        if (end > observedAtMs) invalid("finish.open period");
        if (finish.periodStart !== null && instant(finish.periodStart, "finish.periodStart") !== start)
          invalid("finish.periodStart");
        return {
          periodType: finish.periodType as LeaderboardFinish["periodType"],
          periodLabel: finish.periodLabel as string,
          rank: positiveInteger(finish.rank, "finish.rank"),
          periodStart: finish.periodStart as string | null,
        };
      });
      if (!finishes.length) invalid("leaderboard.finishes");
      return { kind: "leaderboard", callout: null, leaderboard: { finishes } };
    };

    if (!plain(data.users)) invalid("users");
    const addresses = Object.keys(data.users);
    if (addresses.length > MAX_USERS) invalid("users");
    for (const address of addresses) {
      text(address, "address");
      const user = record(data.users[address], ["achievements", "progress"], "user");
      let previousIndex = -1;
      const achievements = list(user.achievements, MAX_CATALOG, "user.achievements").map((value) => {
        const row = record(value, UNLOCK_KEYS, "unlock");
        const achievementId = catalogId(row.achievementId, "unlock.achievementId");
        // Ordered by catalog sortOrder; one unlock per achievement.
        const index = sortIndex.get(achievementId) as number;
        if (index <= previousIndex) invalid("unlock order");
        previousIndex = index;
        timeBeforeSnapshot(row.unlockedAt, "unlock.unlockedAt");
        const holderCount = row.holderCount === null ? null : positiveInteger(row.holderCount, "unlock.holderCount");
        const holderPercent = nullableFinite(row.holderPercent, "unlock.holderPercent");
        if (holderPercent !== null && (holderCount === null || holderPercent < 0 || holderPercent > 100))
          invalid("unlock.holderPercent");
        return {
          achievementId,
          unlockedAt: row.unlockedAt as string | null,
          value: nullableFinite(row.value, "unlock.value"),
          holderCount,
          holderPercent,
          evidence: evidence(row.evidence),
        };
      });
      const metrics = new Set<string>();
      const progress = list(user.progress, MAX_CATALOG, "user.progress").map((value) => {
        const row = record(value, PROGRESS_KEYS, "progress");
        const metric = text(row.metric, "progress.metric");
        if (metrics.has(metric)) invalid("duplicate progress metric");
        metrics.add(metric);
        const nextThreshold = nullableFinite(row.nextThreshold, "progress.nextThreshold");
        const nextAchievementId = row.nextAchievementId === null ? null : catalogId(row.nextAchievementId, "progress.nextAchievementId");
        const previousThreshold = nullableFinite(row.previousThreshold, "progress.previousThreshold");
        const previousAchievementId =
          row.previousAchievementId === null ? null : catalogId(row.previousAchievementId, "progress.previousAchievementId");
        // A tier is named exactly when its threshold is; a maxed or unstarted track nulls both.
        if ((nextThreshold === null) !== (nextAchievementId === null)) invalid("progress.next tier");
        if ((previousThreshold === null) !== (previousAchievementId === null)) invalid("progress.previous tier");
        if (nextThreshold !== null && previousThreshold !== null && !(previousThreshold < nextThreshold))
          invalid("progress.rung");
        if (nextAchievementId !== null && nextAchievementId === previousAchievementId) invalid("progress.rung");
        return {
          metric,
          currentValue: finite(row.currentValue, "progress.currentValue"),
          nextThreshold,
          nextAchievementId,
          previousThreshold,
          previousAchievementId,
        };
      });
      this.#users.set(address, { achievements, progress });
    }
  }

  achievements(address: string): UserAchievements {
    const user = this.#users.get(address);
    if (!user) throw new UnavailableUserAchievementsError("No supplied achievements for this user");
    return {
      achievements: user.achievements.map((unlock) => ({
        achievementId: unlock.achievementId,
        unlockedAt: unlock.unlockedAt,
        value: unlock.value,
        // Viewer-relative acknowledgement is absent on the API host.
        seen: false,
        holderCount: unlock.holderCount,
        holderPercent: unlock.holderPercent,
        evidence: unlock.evidence && {
          kind: unlock.evidence.kind,
          callout: unlock.evidence.callout && { ...unlock.evidence.callout },
          leaderboard: unlock.evidence.leaderboard && {
            finishes: unlock.evidence.leaderboard.finishes.map((finish) => ({ ...finish })),
          },
        },
      })),
      progress: user.progress.map((row) => ({ ...row })),
      catalogVersion: this.#catalogVersion,
    };
  }
}

/** Startup-only, bounded regular-file read. No writes, reloads or network. */
export function loadUserAchievementsStore(
  path: string | undefined,
  noFollow: number | undefined = constants.O_NOFOLLOW,
): UserAchievementsStore | undefined {
  if (!path) return undefined;
  // O_NOFOLLOW is undefined on Windows, so the open flag alone cannot reject a
  // symlinked path there: inspect the path itself and bind the descriptor to it.
  const linked = lstatSync(path, { bigint: true });
  if (linked.isSymbolicLink() || !linked.isFile()) invalid("file type/size");
  const fd = openSync(path, constants.O_RDONLY | (noFollow ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(MAX_FILE_BYTES)) invalid("file type/size");
    if (stat.dev !== linked.dev || stat.ino !== linked.ino) invalid("file identity");
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = readSync(fd, buffer, size, buffer.length - size, null);
      if (read === 0) break;
      size += read;
    }
    if (size > MAX_FILE_BYTES) invalid("file size");
    return new UserAchievementsStore(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))),
    );
  } finally {
    closeSync(fd);
  }
}
