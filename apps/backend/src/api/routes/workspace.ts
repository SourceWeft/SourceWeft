import { Hono } from "hono";
import { workspaceService } from "../../modules/workspace";
import type { WorkspaceMemberMutationResult } from "../../modules/workspace";
import { isWorkspaceRole } from "../../modules/workspace/types";
import { teamAuditService } from "../../modules/team-audit";
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

/**
 * `not_found` covers both "no such workspace" and "you are not a member of it",
 * so a non-member cannot use this endpoint to probe for workspace ids.
 */
function throwMemberMutationError(
  result: WorkspaceMemberMutationResult,
): never {
  if (result.ok) {
    throw new Error("Expected a failed workspace member mutation");
  }

  if (result.reason === "forbidden") {
    throw ApiError.forbidden(
      "Only workspace admins can manage workspace members.",
    );
  }

  throw new ApiError(404, "WORKSPACE_MEMBER_NOT_FOUND", "Member not found");
}

function parseRole(body: Record<string, unknown>) {
  const role = body.role;
  if (!isWorkspaceRole(role)) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "role must be one of workspace_admin, editor, viewer",
    );
  }

  return role;
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

    // Unconditionally, not only when the list comes back empty. This is what
    // makes the shared workspace appear for organizations that predate it:
    // creation is idempotent, and because membership of it is derived, the
    // whole team is in it the moment it exists. No migration, no backfill.
    await workspaceService.ensureMembershipWorkspace({
      organizationId: teamId,
      userId,
    });

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

  app.get("/v1/workspaces/:workspaceId/members", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const members = await workspaceService.listWorkspaceMembers({
      workspaceId: c.req.param("workspaceId"),
      userId: getSessionUserId(session),
    });

    if (!members) {
      throw new ApiError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
    }

    return ApiResponse.success(c, { items: members });
  });

  app.post("/v1/workspaces/:workspaceId/members", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const targetUserId = typeof body.userId === "string" ? body.userId : "";

    if (!targetUserId) {
      throw new ApiError(400, "VALIDATION_ERROR", "userId is required");
    }

    const result = await workspaceService.addWorkspaceMember({
      workspaceId: c.req.param("workspaceId"),
      actorUserId: getSessionUserId(session),
      userId: targetUserId,
      role: parseRole(body),
    });

    if (!result.ok) {
      throwMemberMutationError(result);
    }

    return ApiResponse.success(c, { ok: true }, 201);
  });

  app.patch("/v1/workspaces/:workspaceId/members/:userId", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => null));

    const result = await workspaceService.updateWorkspaceMemberRole({
      workspaceId: c.req.param("workspaceId"),
      actorUserId: getSessionUserId(session),
      userId: c.req.param("userId"),
      role: parseRole(body),
    });

    if (!result.ok) {
      throwMemberMutationError(result);
    }

    return ApiResponse.success(c, { ok: true });
  });

  app.delete("/v1/workspaces/:workspaceId/members/:userId", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await workspaceService.removeWorkspaceMember({
      workspaceId: c.req.param("workspaceId"),
      actorUserId: getSessionUserId(session),
      userId: c.req.param("userId"),
    });

    if (!result.ok) {
      throwMemberMutationError(result);
    }

    return ApiResponse.success(c, { ok: true });
  });

  app.get("/v1/teams/:teamId/audit-logs", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const teamId = c.req.param("teamId");
    const isAdmin = await workspaceService.isOrganizationAdmin({
      organizationId: teamId,
      userId: getSessionUserId(session),
    });

    if (!isAdmin) {
      throw ApiError.forbidden();
    }

    const rawLimit = c.req.query("limit");
    const limit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;

    const items = await teamAuditService.list({
      teamId,
      limit: Number.isFinite(limit) ? limit : undefined,
    });

    return ApiResponse.success(c, { items });
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
    let workspace = requestedWorkspaceId
      ? await workspaceService.resolveWorkspace({
          workspaceId: requestedWorkspaceId,
          userId,
        })
      : null;

    if (!requestedWorkspaceId && !workspace && organizationId) {
      workspace = await workspaceService.ensureMembershipWorkspace({
        organizationId,
        userId,
      });
    }

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
