import type { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "@sourceweft/db";
import { findMcp, listMcp } from "../../modules/market/read-repository";
import {
  createReadinessProbe,
  type ReadinessProbe,
} from "../../modules/readiness/probe";
import { logger } from "../../shared/logger";
import { ApiResponse } from "../response/api-response";

// A ping on a healthy pool answers in milliseconds; two seconds means the
// pool is exhausted or the database is not answering.
export const READINESS_DATABASE_BUDGET_MS = 2_000;
// Below the web app's own limit on a catalog read (8 s), so the monitor sees
// the read path degrade before public pages start to fail.
export const READINESS_CATALOG_BUDGET_MS = 5_000;

async function pingDatabase() {
  await db.execute(sql`select 1`);
}

/**
 * What a public MCP detail page costs the API: the newest public server, read
 * the way `GET /v1/mcp/:identifier` reads it (same function, same options).
 * An empty catalog passes: the list read itself worked.
 */
async function readCatalogDetail() {
  const { items } = await listMcp({ includeDesktopOnly: true, limit: 1 });
  const first = items[0];
  if (!first) {
    return;
  }
  const record = await findMcp(first.identifier, {
    locale: "en",
    relatedProduct: true,
    toolsRevision: true,
    referenceTools: true,
  });
  if (!record) {
    throw new Error("A listed MCP server has no detail");
  }
}

const defaultProbe = createReadinessProbe(
  [
    {
      name: "database",
      budgetMs: READINESS_DATABASE_BUDGET_MS,
      run: pingDatabase,
    },
    {
      name: "catalog",
      budgetMs: READINESS_CATALOG_BUDGET_MS,
      run: readCatalogDetail,
    },
  ],
  {
    // The cause goes to the server's log only; the response names the check
    // and nothing else, since an error's text can carry hostnames.
    onFailure: ({ check, reason, durationMs, error }) =>
      logger.warn("Readiness check failed", {
        check,
        reason,
        durationMs,
        ...(error === undefined
          ? {}
          : { error: error instanceof Error ? error.message : String(error) }),
      }),
  },
);

/**
 * `GET /v1/health/ready`, for an external monitor: 200 when every check
 * passed within its budget, 503 naming the failed ones otherwise.
 * Unauthenticated; `/v1/health` stays the liveness answer containers use.
 */
export function registerHealthReadyRoute(
  app: Hono,
  probe: ReadinessProbe = defaultProbe,
) {
  app.get("/v1/health/ready", async (c) => {
    const report = await probe.run();
    c.header("Cache-Control", "no-store");
    return ApiResponse.success(c, report, report.status === "ok" ? 200 : 503);
  });
}
