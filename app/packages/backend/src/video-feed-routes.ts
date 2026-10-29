import type { FastifyInstance } from "fastify";
import type { VideoFeedStore } from "./video-feed-store.js";

export const VIDEO_FEED_NATIVE_ROUTES = new Set(["GET /feed/video-feed"]);

/** Must be registered inside the existing developer API-key compatibility gate. */
export function registerVideoFeedRoutes(app: FastifyInstance, store: VideoFeedStore): void {
  app.get("/v1/feed/video-feed", async (request, reply) => {
    // The operation declares no query parameters.
    const separator = request.url.indexOf("?");
    if (separator >= 0 && [...new URLSearchParams(request.url.slice(separator + 1)).keys()].length)
      return reply.code(400).send({ statusCode: 400, error: "INVALID_QUERY" });
    return reply
      .header("X-Reconstruction-Data-Source", store.dataSource)
      .header("X-Reconstruction-Observed-At", store.observedAt)
      .header("X-Reconstruction-Compatibility", "unqualified")
      .send(store.feed());
  });
}
