import type { FastifyInstance } from "fastify";
import {
  AchievementOverlaysStore,
  UnavailableAchievementOverlaysError,
  isOverlayId,
} from "./achievement-overlays-store.js";

export const ACHIEVEMENT_OVERLAYS_NATIVE_ROUTES = new Set(["POST /achievements/overlays"]);

/** Must be registered inside the existing developer API-key compatibility gate. */
export function registerAchievementOverlaysRoutes(app: FastifyInstance, store: AchievementOverlaysStore): void {
  app.post("/v1/achievements/overlays", async (request, reply) => {
    // The operation declares no query parameters.
    const separator = request.url.indexOf("?");
    if (separator >= 0 && [...new URLSearchParams(request.url.slice(separator + 1)).keys()].length)
      return reply.code(400).send({ statusCode: 400, error: "INVALID_QUERY" });
    // Declared body: exactly `ids`, 1-100 wallet addresses or user ids.
    const body = request.body as Record<string, unknown> | null;
    if (
      !body ||
      typeof body !== "object" ||
      Object.keys(body).length !== 1 ||
      !Array.isArray(body.ids) ||
      body.ids.length < 1 ||
      body.ids.length > 100 ||
      !body.ids.every((id, index) => Object.hasOwn(body.ids as unknown[], index) && isOverlayId(id))
    )
      return reply.code(400).send({ statusCode: 400, error: "INVALID_BODY" });
    try {
      const overlays = store.overlays(body.ids as string[]);
      return reply
        .code(201)
        .header("X-Reconstruction-Data-Source", store.dataSource)
        .header("X-Reconstruction-Observed-At", store.observedAt)
        .header("X-Reconstruction-Compatibility", "unqualified")
        .send(overlays);
    } catch (error) {
      if (error instanceof UnavailableAchievementOverlaysError)
        return reply.code(501).send({
          statusCode: 501,
          error: "COMPATIBILITY_NOT_IMPLEMENTED",
          reason: "ACHIEVEMENT_OVERLAYS_UNAVAILABLE",
        });
      throw error;
    }
  });
}
