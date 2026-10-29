import type { FastifyInstance } from "fastify";
import {
  MintPositionsStore,
  UnavailableMintPositionsError,
  type MintPositionsSort,
} from "./mint-positions-store.js";

export const MINT_POSITIONS_NATIVE_ROUTES = new Set(["GET /mint-positions/{mint}"]);

const KEYS = [
  "sortBy", "page", "pageSize", "withThesis", "updatesLimit", "includeProfile", "dustFloorUsd",
  "pageToken", "forceRefresh", "chainId", "session_id", "device_id", "country", "os", "platform",
  "chain", "scope",
];
/** Declared RANKED-only inputs, with their declared string bounds. */
const RANKED_ONLY: Record<string, [number, number]> = {
  pageToken: [0, 256], session_id: [0, 128], device_id: [0, 128], country: [2, 8], os: [0, 16], platform: [0, 16],
};
const CHAIN = /^(?:(?:hlcore|near):mainnet|starknet:SN_MAIN|ton:-239)$/;

function integer(value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new RangeError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new RangeError();
  return parsed;
}
function boolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value !== "true" && value !== "false") throw new RangeError();
  return value === "true";
}
function unavailable(reason: string): never {
  throw new UnavailableMintPositionsError(reason);
}

/** Must be registered inside the existing developer API-key compatibility gate. */
export function registerMintPositionsRoutes(app: FastifyInstance, store: MintPositionsStore): void {
  app.get("/v1/mint-positions/:mint", async (request, reply) => {
    try {
      const query = new Map<string, string>();
      const separator = request.url.indexOf("?");
      for (const [key, value] of new URLSearchParams(
        separator < 0 ? "" : request.url.slice(separator + 1),
      )) {
        if (!KEYS.includes(key) || query.has(key)) throw new RangeError();
        query.set(key, value);
      }
      const sortBy = query.get("sortBy");
      if (sortBy !== undefined && !["LATEST", "TOP", "LOWEST_ENTRY", "RANKED", "CLOSED_PNL"].includes(sortBy))
        throw new RangeError();
      const page = integer(query.get("page"), 0, Number.MAX_SAFE_INTEGER);
      const pageSize = integer(query.get("pageSize"), 1, 50);
      const withThesis = boolean(query.get("withThesis"));
      const updatesLimit = integer(query.get("updatesLimit"), 0, 20);
      const includeProfile = boolean(query.get("includeProfile"));
      const dust = query.get("dustFloorUsd");
      if (dust !== undefined) {
        const value = Number(dust);
        if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(dust) || value > 100_000) throw new RangeError();
        // Declared: rejected with sortBy=CLOSED_PNL.
        if (sortBy === "CLOSED_PNL") throw new RangeError();
      }
      boolean(query.get("forceRefresh"));
      integer(query.get("chainId"), 1, Number.MAX_SAFE_INTEGER);
      for (const [key, [min, max]] of Object.entries(RANKED_ONLY)) {
        const value = query.get(key);
        if (value !== undefined && (value.length < min || value.length > max)) throw new RangeError();
      }
      const chain = query.get("chain");
      if (chain !== undefined && !CHAIN.test(chain)) throw new RangeError();
      const scope = query.get("scope");
      if (scope !== undefined && scope !== "mint" && scope !== "pairs") throw new RangeError();
      // Declared: pageToken and page are mutually exclusive.
      if (query.has("pageToken") && page !== undefined) throw new RangeError();
      const rankedOnly = ["forceRefresh", "chainId", ...Object.keys(RANKED_ONLY)].some((key) => query.has(key));
      if (rankedOnly && sortBy !== "RANKED") throw new RangeError();

      if (sortBy === "RANKED") unavailable("RANKED_UNAVAILABLE");
      if (chain !== undefined) unavailable("CHAIN_UNAVAILABLE");
      if (scope === "pairs") unavailable("PAIRS_SCOPE_UNAVAILABLE");
      if (dust !== undefined) unavailable("DUST_FLOOR_UNAVAILABLE");
      if (sortBy === undefined) unavailable("DEFAULT_SORT_UNDECLARED");

      const { mint } = request.params as { mint: string };
      const body = store.page(mint, {
        sortBy: sortBy as MintPositionsSort,
        page,
        pageSize,
        withThesis,
        updatesLimit,
        includeProfile,
      });
      return reply
        .header("X-Reconstruction-Data-Source", store.dataSource)
        .header("X-Reconstruction-Observed-At", store.observedAt)
        .header("X-Reconstruction-Compatibility", "unqualified")
        .send(body);
    } catch (error) {
      if (error instanceof RangeError)
        return reply.code(400).send({ statusCode: 400, error: "INVALID_QUERY" });
      if (error instanceof UnavailableMintPositionsError)
        return reply.code(501).send({
          statusCode: 501,
          error: "COMPATIBILITY_NOT_IMPLEMENTED",
          reason: error.reason,
        });
      throw error;
    }
  });
}
