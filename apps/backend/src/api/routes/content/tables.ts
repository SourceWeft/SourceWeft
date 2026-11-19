import type { Context, Hono } from "hono";
import {
  tableGenerateRequestSchema,
  tableRegenerateRequestSchema,
  tableSuggestColumnsRequestSchema,
} from "@sourceweft/contracts/table";
import { billingRuntime as billingService } from "../../../billing-host/bindings";
import {
  estimateTable,
  getTableFreshness,
  requestTableArtifact,
  requestTableColumnSuggestions,
  requestTableRegeneration,
} from "../../../modules/tables/requests";
import { ApiError, ApiResponse } from "../../response/api-response";
import { sessionUser, uiLocaleOf } from "./generation-route";
import { requireRouteParam } from "./helpers";

type Schema<T> = {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: { flatten(): unknown } };
};

/** A table request that does not match its schema is unprocessable: 422. */
async function parseBody<T>(c: Context, schema: Schema<T>, options: { emptyIs?: unknown } = {}) {
  const text = await c.req.text().catch(() => "");
  let value: unknown = null;
  if (text.trim() === "" && "emptyIs" in options) {
    value = options.emptyIs;
  } else {
    try {
      value = JSON.parse(text);
    } catch {
      value = null;
    }
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "Invalid request body",
      parsed.error.flatten() as Record<string, unknown>,
    );
  }
  return parsed.data;
}

/** Data tables: columns, estimate, generation, regeneration and freshness. */
export function registerTableRoutes(app: Hono) {
  app.post("/tables/columns/suggest", async (c) => {
    const userId = await sessionUser(c);
    const request = await parseBody(c, tableSuggestColumnsRequestSchema);
    return ApiResponse.success(
      c,
      await requestTableColumnSuggestions({
        workspaceId: requireRouteParam(c, "workspaceId"),
        userId,
        uiLocale: uiLocaleOf(c),
        billing: billingService,
        request,
      }),
    );
  });

  app.post("/tables/estimate", async (c) => {
    const userId = await sessionUser(c);
    const request = await parseBody(c, tableGenerateRequestSchema);
    return ApiResponse.success(
      c,
      await estimateTable({
        workspaceId: requireRouteParam(c, "workspaceId"),
        userId,
        uiLocale: uiLocaleOf(c),
        request,
      }),
    );
  });

  app.post("/tables/artifacts", async (c) => {
    const userId = await sessionUser(c);
    const request = await parseBody(c, tableGenerateRequestSchema);
    return ApiResponse.success(
      c,
      await requestTableArtifact({
        workspaceId: requireRouteParam(c, "workspaceId"),
        userId,
        uiLocale: uiLocaleOf(c),
        request,
      }),
      202,
    );
  });

  app.post("/tables/artifacts/:id/regenerate", async (c) => {
    const userId = await sessionUser(c);
    // No body at all keeps the previous recipe, like an empty object.
    const body = await parseBody(c, tableRegenerateRequestSchema, { emptyIs: {} });
    return ApiResponse.success(
      c,
      await requestTableRegeneration({
        workspaceId: requireRouteParam(c, "workspaceId"),
        artifactId: requireRouteParam(c, "id"),
        userId,
        uiLocale: uiLocaleOf(c),
        body,
      }),
      202,
    );
  });

  app.get("/tables/artifacts/:id/freshness", async (c) => {
    const userId = await sessionUser(c);
    return ApiResponse.success(
      c,
      await getTableFreshness({
        workspaceId: requireRouteParam(c, "workspaceId"),
        artifactId: requireRouteParam(c, "id"),
        userId,
      }),
    );
  });
}
