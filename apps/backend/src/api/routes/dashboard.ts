import { Hono } from "hono";
import { contentThreadService } from "../../modules/threads";
import { workspaceService } from "../../modules/workspace";
import {
  getActiveOrganizationId,
  getSessionUserId,
  requireSession,
} from "../middleware/auth-session";
import { ApiError, ApiResponse } from "../response/api-response";

const THREADS_PAGE_SIZE = 20;
const DASHBOARD_WORKSPACE_CACHE_TTL_MS = 30 * 60 * 1000;
const DASHBOARD_CACHE_HINTS = Object.freeze({
  workspaceSources: {
    version: "v1",
    ttlMs: DASHBOARD_WORKSPACE_CACHE_TTL_MS,
  },
  workspaceHub: {
    version: "v1",
    ttlMs: DASHBOARD_WORKSPACE_CACHE_TTL_MS,
    buckets: ["artifacts", "connectors", "mcp"],
  },
});

type BootstrapWarning = {
  field: string;
  code: string;
  message: string;
};

function warningFromError(field: string, error: unknown): BootstrapWarning {
  const maybe = error as { code?: unknown; message?: unknown };
  return {
    field,
    code: typeof maybe.code === "string" ? maybe.code : "BOOTSTRAP_FIELD_ERROR",
    message:
      typeof maybe.message === "string"
        ? maybe.message
        : `Failed to load ${field}`,
  };
}

function parseBooleanQuery(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === "") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw new ApiError(
    400,
    "INVALID_BOOLEAN",
    "boolean query parameter must be true or false",
  );
}

export function registerDashboardRoutes(app: Hono) {
  const routes = new Hono();

  routes.get("/chat/bootstrap", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const userId = getSessionUserId(session);
    const includeModelCatalog = parseBooleanQuery(
      c.req.query("includeModelCatalog"),
      true,
    );
    const requestedWorkspaceId = c.req.query("workspaceId")?.trim() || null;
    const sessionOrganizationId = getActiveOrganizationId(session);
    const personalMembership = sessionOrganizationId
      ? null
      : await workspaceService.findPersonalOrganizationMembershipByUser(userId);
    const activeOrganizationId =
      sessionOrganizationId ?? personalMembership?.organizationId ?? null;

    if (!activeOrganizationId) {
      throw new ApiError(
        404,
        "ORGANIZATION_NOT_FOUND",
        "Organization not found",
      );
    }

    const membership = await workspaceService.getOrganizationMembership({
      organizationId: activeOrganizationId,
      userId,
    });
    if (!membership) {
      throw ApiError.forbidden();
    }

    let workspaces = await workspaceService.listWorkspaces({
      organizationId: activeOrganizationId,
      userId,
    });
    if (workspaces.length === 0) {
      const workspace =
        await workspaceService.ensureUserWorkspaceInOrganization({
          organizationId: activeOrganizationId,
          userId,
        });
      workspaces = [workspace];
    }

    let activeWorkspace = requestedWorkspaceId
      ? (workspaces.find(
          (workspace) => workspace.id === requestedWorkspaceId,
        ) ?? null)
      : (workspaces[0] ?? null);

    if (requestedWorkspaceId && !activeWorkspace) {
      const resolved = await workspaceService.resolveWorkspace({
        workspaceId: requestedWorkspaceId,
        userId,
      });
      if (!resolved) {
        throw new ApiError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
      }
      if (resolved.organizationId !== activeOrganizationId) {
        throw ApiError.forbidden();
      }
      activeWorkspace = resolved;
      workspaces = [...workspaces, resolved];
    }

    if (!activeWorkspace) {
      activeWorkspace =
        await workspaceService.ensureUserWorkspaceInOrganization({
          organizationId: activeOrganizationId,
          userId,
        });
      workspaces = [activeWorkspace];
    }

    const organization =
      await workspaceService.getOrganization(activeOrganizationId);
    const activeOrganizationName = organization?.name ?? "SourceWeft";
    const warnings: BootstrapWarning[] = [];

    const [
      privateChatsResult,
      initialChatPreferencesResult,
      modelCatalogResult,
    ] = await Promise.allSettled([
      contentThreadService.listThreads({
        workspaceId: activeWorkspace.id,
        userId,
        limit: THREADS_PAGE_SIZE,
      }),
      contentThreadService.getInitialChatPreferences({
        workspaceId: activeWorkspace.id,
        userId,
      }),
      includeModelCatalog
        ? contentThreadService.listThreadModelCatalog({
            workspaceId: activeWorkspace.id,
            userId,
          })
        : Promise.resolve(null),
    ]);

    if (privateChatsResult.status === "rejected") {
      throw privateChatsResult.reason;
    }
    if (initialChatPreferencesResult.status === "rejected") {
      throw initialChatPreferencesResult.reason;
    }

    let modelCatalog =
      modelCatalogResult.status === "fulfilled"
        ? modelCatalogResult.value
        : null;
    if (modelCatalogResult.status === "rejected") {
      warnings.push(
        warningFromError("modelCatalog", modelCatalogResult.reason),
      );
    }

    return ApiResponse.success(c, {
      authenticated: true,
      user: session.user,
      activeOrganizationId,
      activeOrganizationName,
      activeWorkspace,
      workspaces,
      privateChats: privateChatsResult.value,
      initialChatPreferences:
        initialChatPreferencesResult.value.initialChatPreferences,
      modelCatalog,
      modelCatalogDeferred: !includeModelCatalog,
      cacheHints: DASHBOARD_CACHE_HINTS,
      warnings,
    });
  });

  app.route("/v1/dashboard", routes);
}
