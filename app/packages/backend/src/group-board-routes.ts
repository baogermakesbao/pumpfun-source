import type { FastifyInstance } from "fastify";
import {
  GroupBoardStore,
  UnavailableGroupBoardError,
  isGroupBoardPeriod,
  isGroupBoardSort,
} from "./group-board-store.js";

export const GROUP_BOARD_NATIVE_ROUTES = new Set(["GET /pnl-leaderboard/groups"]);

/** Declared as integers; the row limit accepts negatives so they can clamp. */
function integer(value: string | undefined, signed: boolean): number | undefined {
  if (value === undefined) return undefined;
  if (!(signed ? /^(?:0|-?[1-9][0-9]*)$/ : /^(?:0|[1-9][0-9]*)$/).test(value))
    throw new RangeError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RangeError();
  return parsed;
}

/** Must be registered inside the existing developer API-key compatibility gate. */
export function registerGroupBoardRoutes(app: FastifyInstance, store: GroupBoardStore): void {
  app.get("/v1/pnl-leaderboard/groups", async (request, reply) => {
    try {
      const query = new Map<string, string>();
      const separator = request.url.indexOf("?");
      for (const [key, value] of new URLSearchParams(
        separator < 0 ? "" : request.url.slice(separator + 1),
      )) {
        if (!["period", "sort", "limit", "positionsLimit"].includes(key) || query.has(key))
          throw new RangeError();
        query.set(key, value);
      }
      const period = query.get("period");
      const sort = query.get("sort");
      if (!isGroupBoardPeriod(period) || (sort !== undefined && !isGroupBoardSort(sort)))
        throw new RangeError();
      const board = store.board({
        period,
        sort,
        limit: integer(query.get("limit"), true),
        positionsLimit: integer(query.get("positionsLimit"), false),
      });
      return reply
        .header("X-Reconstruction-Data-Source", store.dataSource)
        .header("X-Reconstruction-Observed-At", store.observedAt)
        .header("X-Reconstruction-Compatibility", "unqualified")
        .send(board);
    } catch (error) {
      if (error instanceof RangeError)
        return reply.code(400).send({ statusCode: 400, error: "INVALID_QUERY" });
      if (error instanceof UnavailableGroupBoardError)
        return reply.code(501).send({
          statusCode: 501,
          error: "COMPATIBILITY_NOT_IMPLEMENTED",
          reason: "GROUP_BOARD_UNAVAILABLE",
        });
      throw error;
    }
  });
}
