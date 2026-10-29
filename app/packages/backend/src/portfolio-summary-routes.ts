import type { FastifyInstance } from "fastify";
import {
  PERIODS,
  PortfolioSummaryUnavailable,
  type Period,
  type PortfolioSummaryStore,
} from "./portfolio-summary-store.js";

export const PORTFOLIO_SUMMARY_NATIVE_ROUTES = new Set(["GET /portfolio-summary"]);

const QUERY_KEYS = ["user", "period", "periods", "fresh", "holdings"];
const PERIODS_PATTERN = /^(1d|1w|1m|all)(,(1d|1w|1m|all))*$/;
const BOOLEANS: Record<string, boolean> = { true: true, "1": true, false: false, "0": false };

function isPeriod(value: string | undefined): value is Period {
  return (PERIODS as readonly (string | undefined)[]).includes(value);
}

/** Must be registered inside the existing developer API-key compatibility gate. */
export function registerPortfolioSummaryRoutes(app: FastifyInstance, store: PortfolioSummaryStore): void {
  app.get("/v1/portfolio-summary", async (request, reply) => {
    const separator = request.url.indexOf("?");
    const entries = separator >= 0 ? [...new URLSearchParams(request.url.slice(separator + 1))] : [];
    const query = Object.fromEntries(entries);
    const badQuery = () => reply.code(400).send({ statusCode: 400, error: "INVALID_QUERY" });
    if (entries.some(([key]) => !QUERY_KEYS.includes(key)) || Object.keys(query).length !== entries.length)
      return badQuery();
    const { user, period, periods, fresh, holdings } = query;
    if (!isPeriod(period)) return badQuery();
    if (periods !== undefined && (periods.length > 15 || !PERIODS_PATTERN.test(periods))) return badQuery();
    for (const flag of [fresh, holdings]) if (flag !== undefined && !Object.hasOwn(BOOLEANS, flag)) return badQuery();
    if (user !== undefined && (!user.length || user.length > 66)) return badQuery();
    // Declared: omitted with an API key answers 400 API_USER_REQUIRED. There is no session principal here.
    if (user === undefined)
      return reply.code(400).send({
        statusCode: 400,
        timestamp: new Date().toISOString(),
        path: request.url.slice(0, separator >= 0 ? separator : undefined),
        error: "API_USER_REQUIRED",
        message: "user is required when calling with an API key",
      });
    // `fresh` is accepted and ignored: every API-host caller is served the cached body.
    try {
      const body = store.summary({
        user,
        period,
        // Repeated windows collapse onto their first key, so order is kept.
        periods: periods === undefined ? undefined : (periods.split(",") as Period[]),
        holdings: holdings !== undefined && BOOLEANS[holdings],
      });
      return reply
        .header("X-Reconstruction-Data-Source", store.dataSource)
        .header("X-Reconstruction-Observed-At", store.observedAt)
        .header("X-Reconstruction-Compatibility", "unqualified")
        .send(body);
    } catch (error) {
      if (error instanceof PortfolioSummaryUnavailable)
        return reply.code(501).send({
          statusCode: 501,
          error: "COMPATIBILITY_NOT_IMPLEMENTED",
          reason: "PORTFOLIO_SUMMARY_UNAVAILABLE",
        });
      throw error;
    }
  });
}
