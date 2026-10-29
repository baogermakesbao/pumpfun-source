import type { FastifyInstance } from "fastify";
import { GeneratedMediaStore, UnavailableGeneratedMediaError, isProfileId } from "./generated-media-store.js";

export const GENERATED_MEDIA_NATIVE_ROUTES = new Set(["POST /profiles/generated-media"]);

/** Must be registered inside the existing developer API-key compatibility gate. */
export function registerGeneratedMediaRoutes(app: FastifyInstance, store: GeneratedMediaStore): void {
  app.post("/v1/profiles/generated-media", async (request, reply) => {
    // The operation declares no query parameters.
    const separator = request.url.indexOf("?");
    if (separator >= 0 && [...new URLSearchParams(request.url.slice(separator + 1)).keys()].length)
      return reply.code(400).send({ statusCode: 400, error: "INVALID_QUERY" });
    // Declared body: exactly `ids`, 1-200 wallet addresses or user ids.
    const body = request.body as Record<string, unknown> | null;
    if (
      !body ||
      typeof body !== "object" ||
      Object.keys(body).length !== 1 ||
      !Array.isArray(body.ids) ||
      body.ids.length < 1 ||
      body.ids.length > 200 ||
      !body.ids.every((id, index) => Object.hasOwn(body.ids as unknown[], index) && isProfileId(id))
    )
      return reply.code(400).send({ statusCode: 400, error: "INVALID_BODY" });
    try {
      // The API host has no authenticated owner, so the owner-only `unseen` is never served.
      const entries = store.entries(body.ids as string[]);
      return reply
        .code(201)
        .header("X-Reconstruction-Data-Source", store.dataSource)
        .header("X-Reconstruction-Observed-At", store.observedAt)
        .header("X-Reconstruction-Compatibility", "unqualified")
        .send(entries);
    } catch (error) {
      if (error instanceof UnavailableGeneratedMediaError)
        return reply.code(501).send({
          statusCode: 501,
          error: "COMPATIBILITY_NOT_IMPLEMENTED",
          reason: "GENERATED_MEDIA_UNAVAILABLE",
        });
      throw error;
    }
  });
}
