import { Hono } from "hono";
import { workspaceService } from "../../modules/workspace";
import {
  getActiveOrganizationId,
  getSessionUserId,
  requireSession,
} from "../middleware/auth-session";
import { ApiError, ApiResponse } from "../response/api-response";

function ensureObjectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw ApiError.invalidJson();
  }

  return value as Record<string, unknown>;
}

export function registerWorkspaceRoutes(app: Hono) {
  app.get("/v1/teams/:teamId/workspaces", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const teamId = c.req.param("teamId");
    const userId = getSessionUserId(session);
    const isMember = await workspaceService.hasOrganizationMembership({
      organizationId: teamId,
      userId,
    });

    if (!isMember) {
      throw ApiError.forbidden();
    }

    const workspaces = await workspaceService.listWorkspaces({
      organizationId: teamId,
      userId,
    });

    return ApiResponse.success(c, { items: workspaces });
  });

  app.post("/v1/teams/:teamId/workspaces", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const teamId = c.req.param("teamId");
    const userId = getSessionUserId(session);
    const membership = await workspaceService.getOrganizationMembership({
      organizationId: teamId,
      userId,
    });

    if (!membership) {
      throw ApiError.forbidden();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const rawName = typeof body.name === "string" ? body.name : "";

    if (!rawName.trim()) {
      throw new ApiError(400, "VALIDATION_ERROR", "name is required");
    }

    const workspace = await workspaceService.createWorkspace({
      organizationId: teamId,
      userId,
      name: rawName,
    });

    return ApiResponse.success(c, workspace, 201);
  });

  app.patch("/v1/workspaces/:workspaceId", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const workspaceId = c.req.param("workspaceId");
    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const rawName = typeof body.name === "string" ? body.name : "";

    if (!rawName.trim()) {
      throw new ApiError(400, "VALIDATION_ERROR", "name is required");
    }

    const result = await workspaceService.updateWorkspaceName({
      workspaceId,
      userId: getSessionUserId(session),
      name: rawName,
    });

    if (!result) {
      throw new ApiError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
    }

    if (result === "forbidden") {
      throw ApiError.forbidden();
    }

    return ApiResponse.success(c, result);
  });

  app.get("/v1/context/current", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      return ApiResponse.success(c, { authenticated: false });
    }

    const userId = getSessionUserId(session);
    const activeOrganizationId = getActiveOrganizationId(session);
    const requestedWorkspaceId =
      c.req.header("x-workspace-id") || c.req.query("workspaceId") || null;

    const organizationId = activeOrganizationId || null;
    const ensureDefaultWorkspace = async (teamId: string) => {
      const listed = await workspaceService.listWorkspaces({
        organizationId: teamId,
        userId,
      });

      if (listed.length > 0) {
        return listed[0] ?? null;
      }

      return null;
    };

    const workspace = requestedWorkspaceId
      ? await workspaceService.resolveWorkspace({
          workspaceId: requestedWorkspaceId,
          userId,
        })
      : organizationId
        ? await ensureDefaultWorkspace(organizationId)
        : null;

    return ApiResponse.success(c, {
      authenticated: true,
      user: session.user,
      activeOrganizationId,
      activeWorkspace: workspace,
    });
  });

  app.post("/v1/context/workspace", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const workspaceId =
      typeof body.workspaceId === "string" ? body.workspaceId : "";

    if (!workspaceId) {
      throw new ApiError(400, "VALIDATION_ERROR", "workspaceId is required");
    }

    const userId = getSessionUserId(session);
    const workspace = await workspaceService.resolveWorkspace({
      workspaceId,
      userId,
    });

    if (!workspace) {
      throw new ApiError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
    }

    return ApiResponse.success(c, { workspace });
  });
}
