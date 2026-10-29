import type { FastifyInstance } from "fastify";
import { AmbiguousMintChainError, TopTraderTradesStore } from "./top-trader-trades-store.js";

export const TOP_TRADER_TRADES_NATIVE_ROUTES = new Set(["GET /pnl-leaderboard/top-trader-trades/{mint}"]);

function integer(value: string | undefined, signed: boolean): number | undefined {
  if (value === undefined) return undefined;
  if (!(signed ? /^(?:0|-?[1-9][0-9]*)$/ : /^(?:0|[1-9][0-9]*)$/).test(value))
    throw new RangeError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RangeError();
  return parsed;
}

/** Must be registered inside the existing developer API-key compatibility gate. */
export function registerTopTraderTradesRoutes(app: FastifyInstance, store: TopTraderTradesStore): void {
  app.get("/v1/pnl-leaderboard/top-trader-trades/:mint", async (request, reply) => {
    try {
      const query = new Map<string, string>();
      const separator = request.url.indexOf("?");
      for (const [key, value] of new URLSearchParams(
        separator < 0 ? "" : request.url.slice(separator + 1),
      )) {
        if (!["chainId", "to", "cursor", "limit"].includes(key) || query.has(key))
          throw new RangeError();
        query.set(key, value);
      }
      const { mint } = request.params as { mint: string };
      const page = store.trades(mint, {
        chainId: integer(query.get("chainId"), true),
        to: integer(query.get("to"), false),
        cursor: query.get("cursor"),
        limit: integer(query.get("limit"), false),
      });
      return reply
        .header("X-Reconstruction-Data-Source", store.dataSource)
        .header("X-Reconstruction-Observed-At", store.observedAt)
        .header("X-Reconstruction-Compatibility", "unqualified")
        .send(page);
    } catch (error) {
      if (error instanceof RangeError)
        return reply.code(400).send({ statusCode: 400, error: "INVALID_QUERY" });
      if (error instanceof AmbiguousMintChainError)
        return reply.code(501).send({
          statusCode: 501,
          error: "COMPATIBILITY_NOT_IMPLEMENTED",
          reason: "MINT_CHAIN_INFERENCE_UNAVAILABLE",
        });
      throw error;
    }
  });
}
