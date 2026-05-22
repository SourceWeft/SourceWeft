import type { Hono } from "hono";
import {
  installMarketMcpRequestSchema,
  updateWorkspaceMcpInstallRequestSchema,
  upsertWorkspaceMcpCredentialsRequestSchema,
} from "@sourceweft/contracts";
import { mcpService } from "../../../modules/mcp";
import { getSessionUserId, requireSession } from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { ensureObjectBody, requireRouteParam } from "./helpers";

function parseBooleanQuery(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }
  return value === "true" || value === "1";
}

export function registerMcpRoutes(app: Hono) {
  app.get("/market/mcp", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await mcpService.listMarketMcp({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      query: c.req.query("query"),
      category: c.req.query("category"),
      includeDesktopOnly: parseBooleanQuery(c.req.query("includeDesktopOnly")),
    });
    return ApiResponse.success(c, result);
  });

  app.get("/market/mcp/:identifier", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await mcpService.getMarketMcp({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      identifier: decodeURIComponent(requireRouteParam(c, "identifier")),
    });
    return ApiResponse.success(c, result);
  });

  app.post("/market/mcp/:identifier/install", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }
    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = installMarketMcpRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await mcpService.installMarketMcp({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      identifier: decodeURIComponent(requireRouteParam(c, "identifier")),
      version: parsed.data.version,
      endpointUrlOverride: parsed.data.endpointUrlOverride,
    });
    return ApiResponse.success(c, result, 201);
  });

  app.get("/mcp-installs", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await mcpService.listInstalls({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
    });
    return ApiResponse.success(c, result);
  });

  app.patch("/mcp-installs/:installId", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }
    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = updateWorkspaceMcpInstallRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await mcpService.updateInstall({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      installId: requireRouteParam(c, "installId"),
      enabled: parsed.data.enabled,
      toolIds: parsed.data.toolIds,
    });
    return ApiResponse.success(c, result);
  });

  app.post("/mcp-installs/:installId/credentials", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }
    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = upsertWorkspaceMcpCredentialsRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await mcpService.upsertCredentials({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      installId: requireRouteParam(c, "installId"),
      ...parsed.data,
    });
    return ApiResponse.success(c, result);
  });

  app.post("/mcp-installs/:installId/test", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await mcpService.testInstall({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      installId: requireRouteParam(c, "installId"),
    });
    return ApiResponse.success(c, result);
  });
}
