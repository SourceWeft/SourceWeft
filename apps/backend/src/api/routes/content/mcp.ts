import type { Hono } from "hono";
import {
  installMarketMcpRequestSchema,
  startWorkspaceMcpOAuthRequestSchema,
  updateWorkspaceMcpInstallRequestSchema,
  upsertWorkspaceMcpCredentialsRequestSchema,
} from "@sourceweft/contracts";
import { marketMcpLocaleSchema } from "@sourceweft/market-contracts";
import { mcpService } from "../../../modules/mcp";
import {
  completeMcpOAuthCallback,
  startMcpOAuthAuthorization,
} from "../../../modules/mcp/oauth-service";
import { findMcpOAuthCompletion } from "../../../modules/mcp/oauth-repository";
import {
  mcpInvalidAttemptUrl,
  mcpReturnUrl,
} from "../../../modules/mcp/oauth-return-to";
import { config } from "../../../shared/config";
import { getSessionUserId, requireSession } from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { parseLocaleQuery } from "../query-params";
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
      desktopOnly: parseBooleanQuery(c.req.query("desktopOnly")),
      limit: parseLimitQuery(c.req.query("limit")),
      cursor: c.req.query("cursor"),
      locale: parseLocaleQuery(marketMcpLocaleSchema, c.req.query("locale")),
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
      // The language of each category's name and description.
      locale:
        parseLocaleQuery(marketMcpLocaleSchema, c.req.query("locale")) ?? "en",
    });
    return ApiResponse.success(c, result);
  });

  app.get("/market/mcp/category-counts", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await mcpService.countMarketMcpCategories({
      includeDesktopOnly: parseBooleanQuery(c.req.query("includeDesktopOnly")),
      desktopOnly: parseBooleanQuery(c.req.query("desktopOnly")),
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      query: c.req.query("query"),
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
      locale: parseLocaleQuery(marketMcpLocaleSchema, c.req.query("locale")),
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
    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = startWorkspaceMcpOAuthRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }
    const result = await startMcpOAuthAuthorization({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      installId: requireRouteParam(c, "installId"),
      returnTo: parsed.data.returnTo,
    });
    return ApiResponse.success(c, result);
  });

  app.post("/mcp-installs/:installId/discover-tools", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await mcpService.discoverToolsForMember({
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
 * Top-level (non-workspace) OAuth routes. The `state` nonce carries the whole
 * pending attempt (user, install, destination), so the callback needs no
 * workspace path segment and takes nothing else from the request: it consumes
 * the attempt once, then bounces the browser to the destination stored with it.
 * An unknown, expired or replayed state goes to a fixed page.
 */
export function registerMcpOAuthCallbackRoutes(app: Hono) {
  app.get("/v1/mcp/oauth/callback", async (c) => {
    const webBase = config.auth.webBaseUrl;
    const state = c.req.query("state");
    if (!state) {
      return c.redirect(mcpInvalidAttemptUrl(webBase));
    }
    try {
      // The callback is a browser navigation: its session, when it has one, is
      // checked against the member the attempt belongs to.
      const session = await requireSession(c).catch(() => null);
      const result = await completeMcpOAuthCallback({
        state,
        code: c.req.query("code"),
        providerError: c.req.query("error"),
        sessionUserId: session ? getSessionUserId(session) : undefined,
      });
      if (result.outcome === "invalid") {
        return c.redirect(mcpInvalidAttemptUrl(webBase));
      }
      if (result.outcome === "connected") {
        return c.redirect(
          mcpReturnUrl(webBase, result.returnTo, {
            mcpOAuth: "connected",
            mcpRef: result.completionRef,
          }),
        );
      }
      return c.redirect(
        mcpReturnUrl(webBase, result.returnTo, {
          mcpOAuth: "error",
          mcpReason: result.reason,
        }),
      );
    } catch {
      return c.redirect(mcpInvalidAttemptUrl(webBase));
    }
  });

  // The page the callback returned to confirms a connection here instead of
  // trusting `?mcpOAuth=connected`: the reference is random, non-secret, and
  // resolves only for the member it was issued to while they are still
  // connected.
  app.get("/v1/mcp/oauth/completions/:ref", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }
    const completion = await findMcpOAuthCompletion({
      userId: getSessionUserId(session),
      ref: requireRouteParam(c, "ref"),
    });
    if (!completion) {
      throw ApiError.notFound("Connection not found");
    }
    return ApiResponse.success(c, completion);
  });
}
