import type { Hono } from "hono";
import {
  installMarketMcpRequestSchema,
  updateWorkspaceMcpInstallRequestSchema,
  upsertWorkspaceMcpCredentialsRequestSchema,
} from "@sourceweft/contracts";
import { mcpService } from "../../../modules/mcp";
import {
  completeMcpOAuthCallback,
  startMcpOAuthAuthorization,
} from "../../../modules/mcp/oauth-service";
import { config } from "../../../shared/config";
import { getSessionUserId, requireSession } from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { ensureObjectBody, requireRouteParam } from "./helpers";

function parseBooleanQuery(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }
  return value === "true" || value === "1";
}

function parseLimitQuery(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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
      limit: parseLimitQuery(c.req.query("limit")),
      cursor: c.req.query("cursor"),
    });
    return ApiResponse.success(c, result);
  });

  app.get("/market/mcp/categories", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await mcpService.listMarketMcpCategories({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
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

  app.get("/mcp-runs", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await mcpService.listToolRuns({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      limit: parseLimitQuery(c.req.query("limit")),
      cursor: c.req.query("cursor"),
    });
    return ApiResponse.success(c, result);
  });

  app.get("/mcp-action-runs", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await mcpService.listActionRuns({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      limit: parseLimitQuery(c.req.query("limit")),
      cursor: c.req.query("cursor"),
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

  app.delete("/mcp-installs/:installId", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await mcpService.deleteInstall({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      installId: requireRouteParam(c, "installId"),
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

  app.post("/mcp-installs/:installId/oauth/authorize", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }
    const result = await startMcpOAuthAuthorization({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      installId: requireRouteParam(c, "installId"),
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

/**
 * Top-level (non-workspace) OAuth redirect target. The `state` nonce carries the
 * (install, user) binding, so this route needs no workspace path segment. On
 * completion it bounces the browser back to the dashboard with a status flag.
 */
export function registerMcpOAuthCallbackRoutes(app: Hono) {
  app.get("/v1/mcp/oauth/callback", async (c) => {
    const base = `${config.auth.webBaseUrl}/dashboard/mcp`;
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (c.req.query("error") || !code || !state) {
      return c.redirect(`${base}?mcpOAuth=error`);
    }
    try {
      await completeMcpOAuthCallback({ code, state });
      return c.redirect(`${base}?mcpOAuth=connected`);
    } catch {
      return c.redirect(`${base}?mcpOAuth=error`);
    }
  });
}
