import type { FastifyInstance, FastifyReply } from "fastify";
import {
  GroupsStore,
  UnavailableGroupPnlWindowError,
  UnavailableInvitedViewError,
  UnknownGroupError,
  type GroupMemberStatusFilter,
  type GroupPnlPeriod,
} from "./groups-store.js";

export const GROUPS_NATIVE_ROUTES = new Set([
  "GET /groups/{groupId}/members",
  "GET /groups/{groupId}/members/pnl",
]);

function integer(value: string | undefined, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new RangeError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new RangeError();
  return parsed;
}

/** Unknown or repeated query keys are rejected rather than ignored. */
function strictQuery(url: string, allowed: readonly string[]): Map<string, string> {
  const query = new Map<string, string>();
  const separator = url.indexOf("?");
  for (const [key, value] of new URLSearchParams(separator < 0 ? "" : url.slice(separator + 1))) {
    if (!allowed.includes(key) || query.has(key)) throw new RangeError();
    query.set(key, value);
  }
  return query;
}

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof RangeError)
    return reply.code(400).send({ statusCode: 400, error: "INVALID_QUERY" });
  if (error instanceof UnknownGroupError)
    return reply.code(404).send({ statusCode: 404, error: "GROUP_NOT_FOUND" });
  if (error instanceof UnavailableInvitedViewError)
    return reply.code(501).send({
      statusCode: 501,
      error: "COMPATIBILITY_NOT_IMPLEMENTED",
      reason: "INVITED_VIEW_REQUIRES_GROUP_ROLE",
    });
  if (error instanceof UnavailableGroupPnlWindowError)
    return reply.code(501).send({
      statusCode: 501,
      error: "COMPATIBILITY_NOT_IMPLEMENTED",
      reason: "GROUP_PNL_WINDOW_UNAVAILABLE",
    });
  throw error;
}

/** Must be registered inside the existing developer API-key compatibility gate. */
export function registerGroupRoutes(app: FastifyInstance, store: GroupsStore): void {
  const send = (reply: FastifyReply, body: unknown) =>
    reply
      .header("X-Reconstruction-Data-Source", store.dataSource)
      .header("X-Reconstruction-Observed-At", store.observedAt)
      .header("X-Reconstruction-Compatibility", "unqualified")
      .send(body);

  app.get("/v1/groups/:groupId/members", async (request, reply) => {
    try {
      const query = strictQuery(request.url, ["status", "limit", "offset"]);
      const status = query.get("status");
      if (status !== undefined && status !== "INVITED" && status !== "ACTIVE")
        throw new RangeError();
      const { groupId } = request.params as { groupId: string };
      return send(
        reply,
        store.members(groupId, {
          status: status as GroupMemberStatusFilter | undefined,
          limit: integer(query.get("limit"), 1, 200),
          offset: integer(query.get("offset"), 0, Number.MAX_SAFE_INTEGER),
        }),
      );
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get("/v1/groups/:groupId/members/pnl", async (request, reply) => {
    try {
      const query = strictQuery(request.url, ["period"]);
      const period = query.get("period");
      if (period !== "1d" && period !== "1w" && period !== "1m") throw new RangeError();
      const { groupId } = request.params as { groupId: string };
      return send(reply, store.membersPnl(groupId, period as GroupPnlPeriod));
    } catch (error) {
      return fail(reply, error);
    }
  });
}
