import type { FastifyInstance } from "fastify";
import { MayhemTopTradersStore, UnavailableMayhemBoardError } from "./mayhem-top-traders-store.js";

export const MAYHEM_TOP_TRADERS_NATIVE_ROUTES = new Set(["GET /mayhem/{mint}/top-traders"]);

/** Must be registered inside the existing developer API-key compatibility gate. */
export function registerMayhemTopTradersRoutes(app: FastifyInstance, store: MayhemTopTradersStore): void {
  app.get("/v1/mayhem/:mint/top-traders", async (request, reply) => {
    // The operation declares no query parameters.
    const separator = request.url.indexOf("?");
    if (separator >= 0 && [...new URLSearchParams(request.url.slice(separator + 1)).keys()].length)
      return reply.code(400).send({ statusCode: 400, error: "INVALID_QUERY" });
    const { mint } = request.params as { mint: string };
    try {
      return reply
        .header("X-Reconstruction-Data-Source", store.dataSource)
        .header("X-Reconstruction-Observed-At", store.observedAt)
        .header("X-Reconstruction-Compatibility", "unqualified")
        .send(store.board(mint));
    } catch (error) {
      if (error instanceof UnavailableMayhemBoardError)
        return reply.code(501).send({
          statusCode: 501,
          error: "COMPATIBILITY_NOT_IMPLEMENTED",
          reason: "MAYHEM_BOARD_UNAVAILABLE",
        });
      throw error;
    }
  });
}
