import { workspaceService } from "../workspace";
import { McpError } from "./errors";

export type McpPermission = "mcp.read" | "mcp.manage" | "mcp.execute";

const WORKSPACE_ROLE_PERMISSIONS: Record<string, Set<McpPermission>> = {
  workspace_admin: new Set(["mcp.read", "mcp.manage", "mcp.execute"]),
  editor: new Set(["mcp.read", "mcp.execute"]),
  viewer: new Set(["mcp.read"]),
};

export async function requireMcpWorkspace(input: {
  workspaceId: string;
  userId: string;
  permission: McpPermission;
}) {
  const workspace = await workspaceService.resolveWorkspace({
    workspaceId: input.workspaceId,
    userId: input.userId,
  });
  if (!workspace) {
    throw new McpError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
  }

  // `resolveWorkspace` has already established content access, so `role` is
  // set here; a container-only administrator never gets this far, which is
  // deliberate — MCP runs surface workspace content.
  const access = await workspaceService.resolveAccess({
    workspaceId: input.workspaceId,
    userId: input.userId,
  });
  const membership = access?.role ? { role: access.role } : null;
  const permissions = membership
    ? WORKSPACE_ROLE_PERMISSIONS[membership.role]
    : undefined;

  if (!permissions?.has(input.permission)) {
    throw new McpError(
      403,
      "MCP_FORBIDDEN",
      "You do not have permission to access MCP in this workspace",
    );
  }

  return { workspace, membership };
}
