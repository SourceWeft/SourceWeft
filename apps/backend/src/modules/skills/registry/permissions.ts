import { workspaceService } from "../../workspace";
import { ContentError } from "../../content/errors";

/**
 * RBAC for skill-registry actions (docs/architecture/skill-registry-index.md §3
 * Stage 1). Mirrors `mcp/permissions.ts`: a content-role → permission-set map
 * plus a `require*` guard, so submitting a community skill is gated like other
 * content-plane writes. Submission is a content contribution, so editors get it
 * (as they do MCP execute); only `viewer` is read-only.
 */
export type SkillPermission = "skills.read" | "skills.submit" | "skills.manage";

const WORKSPACE_ROLE_PERMISSIONS: Record<string, Set<SkillPermission>> = {
  workspace_admin: new Set(["skills.read", "skills.submit", "skills.manage"]),
  editor: new Set(["skills.read", "skills.submit"]),
  viewer: new Set(["skills.read"]),
};

export async function requireSkillWorkspace(input: {
  workspaceId: string;
  userId: string;
  permission: SkillPermission;
}) {
  const workspace = await workspaceService.resolveWorkspace({
    workspaceId: input.workspaceId,
    userId: input.userId,
  });
  // `WORKSPACE_NOT_FOUND` (not 403) so a non-member can't probe workspace ids —
  // the same posture as `requireContentWorkspace`.
  if (!workspace) {
    throw new ContentError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
  }

  const access = await workspaceService.resolveAccess({
    workspaceId: input.workspaceId,
    userId: input.userId,
  });
  const permissions = access?.role
    ? WORKSPACE_ROLE_PERMISSIONS[access.role]
    : undefined;
  if (!permissions?.has(input.permission)) {
    throw new ContentError(
      403,
      "SKILLS_FORBIDDEN",
      "You do not have permission to submit skills in this workspace",
    );
  }

  return { workspace };
}
