import { Hono } from "hono";
import { contentService } from "../../modules/content";
import { workspaceService } from "../../modules/workspace";
import {
  getActiveOrganizationId,
  getSessionUserId,
  requireSession,
} from "../middleware/auth-session";
import { ApiError, ApiResponse } from "../response/api-response";

const THREADS_PAGE_SIZE = 20;

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

export function registerDashboardRoutes(app: Hono) {
  const routes = new Hono();

  routes.get("/chat/bootstrap", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const userId = getSessionUserId(session);
    const requestedWorkspaceId = c.req.query("workspaceId")?.trim() || null;
    const sessionOrganizationId = getActiveOrganizationId(session);
    const personalMembership =
      sessionOrganizationId
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
      const workspace = await workspaceService.ensureUserWorkspaceInOrganization({
        organizationId: activeOrganizationId,
        userId,
      });
      workspaces = [workspace];
    }

    let activeWorkspace = requestedWorkspaceId
      ? workspaces.find((workspace) => workspace.id === requestedWorkspaceId) ??
        null
      : workspaces[0] ?? null;

    if (requestedWorkspaceId && !activeWorkspace) {
      const resolved = await workspaceService.resolveWorkspace({
        workspaceId: requestedWorkspaceId,
        userId,
      });
      if (!resolved) {
        throw new ApiError(
          404,
          "WORKSPACE_NOT_FOUND",
          "Workspace not found",
        );
      }
      if (resolved.organizationId !== activeOrganizationId) {
        throw ApiError.forbidden();
      }
      activeWorkspace = resolved;
      workspaces = [...workspaces, resolved];
    }

    if (!activeWorkspace) {
      activeWorkspace = await workspaceService.ensureUserWorkspaceInOrganization({
        organizationId: activeOrganizationId,
        userId,
      });
      workspaces = [activeWorkspace];
    }

    const organization = await workspaceService.getOrganization(activeOrganizationId);
    const activeOrganizationName = organization?.name ?? "SourceWeft";
    const warnings: BootstrapWarning[] = [];

    const [privateChatsResult, modelCatalogResult] = await Promise.allSettled([
      contentService.listThreads({
        workspaceId: activeWorkspace.id,
        userId,
        limit: THREADS_PAGE_SIZE,
      }),
      contentService.listThreadModelCatalog({
        workspaceId: activeWorkspace.id,
        userId,
      }),
    ]);

    if (privateChatsResult.status === "rejected") {
      throw privateChatsResult.reason;
    }

    let modelCatalog =
      modelCatalogResult.status === "fulfilled" ? modelCatalogResult.value : null;
    if (modelCatalogResult.status === "rejected") {
      warnings.push(warningFromError("modelCatalog", modelCatalogResult.reason));
    }

    return ApiResponse.success(c, {
      authenticated: true,
      user: session.user,
      activeOrganizationId,
      activeOrganizationName,
      activeWorkspace,
      workspaces,
      privateChats: privateChatsResult.value,
      modelCatalog,
      warnings,
    });
  });

  app.route("/v1/dashboard", routes);
}
