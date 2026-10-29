import type { FastifyInstance } from "fastify";
import { UnavailableUserAchievementsError, UserAchievementsStore } from "./user-achievements-store.js";

export const USER_ACHIEVEMENTS_NATIVE_ROUTES = new Set(["GET /users/{address}/achievements"]);

/** Must be registered inside the existing developer API-key compatibility gate. */
export function registerUserAchievementsRoutes(app: FastifyInstance, store: UserAchievementsStore): void {
  app.get("/v1/users/:address/achievements", async (request, reply) => {
    // The operation declares no query parameters.
    const separator = request.url.indexOf("?");
    if (separator >= 0 && [...new URLSearchParams(request.url.slice(separator + 1)).keys()].length)
      return reply.code(400).send({ statusCode: 400, error: "INVALID_QUERY" });
    const { address } = request.params as { address: string };
    try {
      return reply
        .header("X-Reconstruction-Data-Source", store.dataSource)
        .header("X-Reconstruction-Observed-At", store.observedAt)
        .header("X-Reconstruction-Compatibility", "unqualified")
        .send(store.achievements(address));
    } catch (error) {
      if (error instanceof UnavailableUserAchievementsError)
        return reply.code(501).send({
          statusCode: 501,
          error: "COMPATIBILITY_NOT_IMPLEMENTED",
          reason: "USER_ACHIEVEMENTS_UNAVAILABLE",
        });
      throw error;
    }
  });
}
