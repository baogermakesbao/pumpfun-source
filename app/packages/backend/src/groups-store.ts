import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { validateAgainstSchema, type SchemaNode, type SchemaRoot } from "./schema-validator.js";

export type GroupPnlPeriod = "1d" | "1w" | "1m";
export type GroupMemberStatusFilter = "INVITED" | "ACTIVE";

/** Local inputs, not a recovered database schema or proof of membership. */
export interface GroupMemberFact {
  /** OpenAPI 0.294.0 normalized profile; null when the account was deleted. */
  profile: Record<string, unknown> | null;
  role: "OWNER" | "ADMIN" | "MEMBER" | "UNSPECIFIED";
  status: "INVITED" | "ACTIVE" | "UNSPECIFIED";
  invitedBy: string | null;
  createdAt: string | null;
}
export interface GroupPnlFoldRow {
  userId: string;
  walletAddress: string;
  pnlUsd: number;
}
export interface GroupPnlFold {
  builtAtMs: number;
  rows: GroupPnlFoldRow[];
}
export interface GroupFact {
  groupId: string;
  members: GroupMemberFact[];
  pnlFolds: Partial<Record<GroupPnlPeriod, GroupPnlFold>>;
}
export interface GroupsDataset {
  schemaVersion: 1;
  dataSource: "synthetic" | "local-materialized";
  observedAt: string;
  /** Explicit window starts (unix seconds); no guessed rolling durations. */
  pnlWindows: Partial<Record<GroupPnlPeriod, { windowStartSec: number }>>;
  groups: GroupFact[];
}
export interface GroupMembersPage {
  members: GroupMemberFact[];
  hasMore: boolean;
}
export interface GroupMembersPnl {
  period: GroupPnlPeriod;
  builtAtMs: number;
  windowStartSec: number;
  rows: GroupPnlFoldRow[];
}
export class UnknownGroupError extends Error {}
export class UnavailableInvitedViewError extends Error {}
export class UnavailableGroupPnlWindowError extends Error {}

const periods: readonly string[] = ["1d", "1w", "1m"];
const roles: readonly string[] = ["OWNER", "ADMIN", "MEMBER", "UNSPECIFIED"];
const statuses: readonly string[] = ["INVITED", "ACTIVE", "UNSPECIFIED"];
/** Declared: the last published board is served for up to 15 minutes. */
const FOLD_SERVE_MS = 15 * 60 * 1000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_GROUPS = 10_000;
const MAX_MEMBERS = 1_000;

const spec = JSON.parse(
  new TextDecoder("utf-8", { fatal: true }).decode(
    readFileSync(new URL("../../../contracts/developer.openapi.json", import.meta.url)),
  ),
) as SchemaRoot & { paths: Record<string, any> };
const profileSchema: SchemaNode =
  spec.paths["/groups/{groupId}/members"].get.responses["200"].content["application/json"]
    .schema.properties.members.items.properties.profile;

function invalid(field: string): never {
  throw new TypeError(`Invalid local groups dataset: ${field}`);
}
function record(value: unknown, keys: readonly string[], field: string) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid(field);
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(item, key))
  )
    invalid(field);
  return item;
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
function timestamp(value: unknown, field: string): string {
  const result = text(value, field);
  const ms = Date.parse(result);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) ||
    !Number.isFinite(ms) ||
    new Date(ms).toISOString() !== result
  )
    invalid(field);
  return result;
}
function list(value: unknown, max: number, field: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(field);
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) invalid(field);
  }
  return value;
}
function periodMap(value: unknown, field: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid(field);
  const keys = Object.keys(value);
  if (keys.some((key) => !periods.includes(key))) invalid(field);
  return record(value, keys, field);
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface StoredGroup {
  members: GroupMemberFact[];
  hasInvited: boolean;
  folds: Map<string, GroupPnlFold>;
}

/** Immutable, opt-in read model. No seeded groups, live data, sessions or writes. */
export class GroupsStore {
  readonly dataSource: GroupsDataset["dataSource"];
  readonly observedAt: string;
  readonly #observedAtMs: number;
  readonly #windows = new Map<string, number>();
  readonly #groups = new Map<string, StoredGroup>();

  constructor(input: unknown) {
    const data = record(
      input,
      ["schemaVersion", "dataSource", "observedAt", "pnlWindows", "groups"],
      "root",
    );
    if (
      data.schemaVersion !== 1 ||
      (data.dataSource !== "synthetic" && data.dataSource !== "local-materialized")
    )
      invalid("version/source");
    this.dataSource = data.dataSource;
    this.observedAt = timestamp(data.observedAt, "observedAt");
    this.#observedAtMs = Date.parse(this.observedAt);

    const windows = periodMap(data.pnlWindows, "pnlWindows");
    for (const [period, value] of Object.entries(windows)) {
      const { windowStartSec } = record(value, ["windowStartSec"], "pnlWindow");
      if (
        !Number.isSafeInteger(windowStartSec) ||
        (windowStartSec as number) < 0 ||
        (windowStartSec as number) * 1000 > this.#observedAtMs
      )
        invalid("pnlWindow.windowStartSec");
      this.#windows.set(period, windowStartSec as number);
    }

    for (const value of list(data.groups, MAX_GROUPS, "groups")) {
      const group = record(value, ["groupId", "members", "pnlFolds"], "group");
      const groupId = text(group.groupId, "group.groupId");
      if (this.#groups.has(groupId)) invalid("duplicate group");
      this.#groups.set(groupId, this.#group(group));
    }
  }

  #group(group: Record<string, unknown>): StoredGroup {
    const owners: GroupMemberFact[] = [];
    const others: GroupMemberFact[] = [];
    const userIds = new Set<string>();
    const active = new Map<string, string | null>();
    for (const value of list(group.members, MAX_MEMBERS, "group.members")) {
      const row = record(
        value,
        ["profile", "role", "status", "invitedBy", "createdAt"],
        "member",
      );
      // Snapshot and check the declared closed profile shape before serving it.
      const profile = row.profile === null ? null : structuredClone(row.profile);
      if (profile !== null && validateAgainstSchema(profile, profileSchema, "$", spec).length)
        invalid("member.profile");
      if (typeof row.role !== "string" || !roles.includes(row.role)) invalid("member.role");
      if (typeof row.status !== "string" || !statuses.includes(row.status))
        invalid("member.status");
      const member: GroupMemberFact = {
        profile: profile as GroupMemberFact["profile"],
        role: row.role as GroupMemberFact["role"],
        status: row.status as GroupMemberFact["status"],
        invitedBy: row.invitedBy === null ? null : text(row.invitedBy, "member.invitedBy"),
        createdAt: row.createdAt === null ? null : timestamp(row.createdAt, "member.createdAt"),
      };
      if (member.createdAt !== null && member.createdAt > this.observedAt)
        invalid("member.createdAt");
      if (member.profile) {
        const userId = member.profile.userId as string;
        if (userIds.has(userId)) invalid("duplicate member");
        userIds.add(userId);
        if (member.status === "ACTIVE")
          active.set(userId, member.profile.walletAddress as string | null);
      }
      if (member.role === "OWNER") {
        if (member.status !== "ACTIVE") invalid("inactive owner");
        owners.push(member);
      } else others.push(member);
    }
    if (owners.length > 1) invalid("multiple owners");
    // Owner first is declared; the order after it is the producer's supplied order.
    const members = [...owners, ...others];

    const folds = new Map<string, GroupPnlFold>();
    for (const [period, value] of Object.entries(periodMap(group.pnlFolds, "pnlFolds"))) {
      const fold = record(value, ["builtAtMs", "rows"], "pnlFold");
      const builtAtMs = fold.builtAtMs;
      const windowStartSec = this.#windows.get(period);
      if (windowStartSec === undefined) invalid("pnlFold without window");
      if (
        !Number.isSafeInteger(builtAtMs) ||
        (builtAtMs as number) <= 0 ||
        (builtAtMs as number) > this.#observedAtMs ||
        (builtAtMs as number) < windowStartSec * 1000
      )
        invalid("pnlFold.builtAtMs");
      const seen = new Set<string>();
      const rows = list(fold.rows, MAX_MEMBERS, "pnlFold.rows").map((item) => {
        const row = record(item, ["userId", "walletAddress", "pnlUsd"], "pnlRow");
        const userId = text(row.userId, "pnlRow.userId");
        const walletAddress = text(row.walletAddress, "pnlRow.walletAddress");
        if (seen.has(userId)) invalid("duplicate pnlRow");
        seen.add(userId);
        // Rows are active members folded for their canonical wallet.
        if (!active.has(userId) || active.get(userId) !== walletAddress)
          invalid("pnlRow member/wallet");
        if (typeof row.pnlUsd !== "number" || !Number.isFinite(row.pnlUsd))
          invalid("pnlRow.pnlUsd");
        return { userId, walletAddress, pnlUsd: row.pnlUsd };
      });
      // Descending PnL is declared; the userId tie order is local policy.
      rows.sort((left, right) =>
        left.pnlUsd !== right.pnlUsd
          ? right.pnlUsd - left.pnlUsd
          : compare(left.userId, right.userId),
      );
      folds.set(period, { builtAtMs: builtAtMs as number, rows });
    }
    return { members, hasInvited: members.some((m) => m.status === "INVITED"), folds };
  }

  #lookup(groupId: string): StoredGroup {
    const group = this.#groups.get(groupId);
    if (!group) throw new UnknownGroupError("No supplied group");
    return group;
  }

  members(
    groupId: string,
    options: { status?: GroupMemberStatusFilter; limit?: number; offset?: number } = {},
  ): GroupMembersPage {
    const { status, limit = 50, offset = 0 } = options;
    if (
      (status !== undefined && status !== "INVITED" && status !== "ACTIVE") ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new RangeError("Invalid group members query");
    const group = this.#lookup(groupId);
    // The declared INVITED view is owner/admin-only, and this host has no viewer.
    if (status === "INVITED" || (status === undefined && group.hasInvited))
      throw new UnavailableInvitedViewError("Invited rows need a viewer role");
    const selected =
      status === undefined ? group.members : group.members.filter((m) => m.status === status);
    return {
      members: selected.slice(offset, offset + limit).map((m) => structuredClone(m)),
      hasMore: offset + limit < selected.length,
    };
  }

  membersPnl(groupId: string, period: GroupPnlPeriod): GroupMembersPnl {
    if (!periods.includes(period)) throw new RangeError("Invalid group PnL query");
    const group = this.#lookup(groupId);
    const windowStartSec = this.#windows.get(period);
    if (windowStartSec === undefined)
      throw new UnavailableGroupPnlWindowError("No supplied group PnL window");
    const fold = group.folds.get(period);
    if (!fold || this.#observedAtMs - fold.builtAtMs > FOLD_SERVE_MS)
      return { period, builtAtMs: 0, windowStartSec, rows: [] };
    return {
      period,
      builtAtMs: fold.builtAtMs,
      windowStartSec,
      rows: fold.rows.map((row) => ({ ...row })),
    };
  }
}

/** Startup-only, bounded regular-file read. No writes, reloads or network. */
export function loadGroupsStore(path: string | undefined): GroupsStore | undefined {
  if (!path) return undefined;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) invalid("file type/size");
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > MAX_FILE_BYTES) invalid("file size");
    return new GroupsStore(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))),
    );
  } finally {
    closeSync(fd);
  }
}
