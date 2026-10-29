import type { FastifyInstance } from "fastify";
import {
  PnlPositionsStore,
  UnavailablePnlPositionsError,
  isPnlPositionsPeriod,
} from "./pnl-positions-store.js";

export const PNL_POSITIONS_NATIVE_ROUTES = new Set(["GET /pnl-leaderboard/positions"]);

/** Declared as integers; the row limit accepts negatives so they can clamp. */
function integer(value: string | undefined, signed: boolean): number | undefined {
  if (value === undefined) return undefined;
  if (!(signed ? /^(?:0|-?[1-9][0-9]*)$/ : /^(?:0|[1-9][0-9]*)$/).test(value))
    throw new RangeError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RangeError();
  return parsed;
}
function boolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value !== "true" && value !== "false") throw new RangeError();
  return value === "true";
}

/** Must be registered inside the existing developer API-key compatibility gate. */
export function registerPnlPositionsRoutes(app: FastifyInstance, store: PnlPositionsStore): void {
  app.get("/v1/pnl-leaderboard/positions", async (request, reply) => {
    try {
      const query = new Map<string, string>();
      const separator = request.url.indexOf("?");
      for (const [key, value] of new URLSearchParams(
        separator < 0 ? "" : request.url.slice(separator + 1),
      )) {
        if (
          !["period", "includeFollowedHolders", "followedHoldersLimit", "limit"].includes(key) ||
          query.has(key)
        )
          throw new RangeError();
        query.set(key, value);
      }
      const period = query.get("period");
      if (!isPnlPositionsPeriod(period)) throw new RangeError();
      const board = store.board({
        period,
        includeFollowedHolders: boolean(query.get("includeFollowedHolders")),
        followedHoldersLimit: integer(query.get("followedHoldersLimit"), false),
        limit: integer(query.get("limit"), true),
      });
      return reply
        .header("X-Reconstruction-Data-Source", store.dataSource)
        .header("X-Reconstruction-Observed-At", store.observedAt)
        .header("X-Reconstruction-Compatibility", "unqualified")
        .send(board);
    } catch (error) {
      if (error instanceof RangeError)
        return reply.code(400).send({ statusCode: 400, error: "INVALID_QUERY" });
      if (error instanceof UnavailablePnlPositionsError)
        return reply.code(501).send({
          statusCode: 501,
          error: "COMPATIBILITY_NOT_IMPLEMENTED",
          reason: "PNL_POSITIONS_BOARD_UNAVAILABLE",
        });
      throw error;
    }
  });
}
