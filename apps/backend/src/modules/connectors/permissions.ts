import { workspaceService } from "../workspace";
import { ConnectorError } from "./errors";

export type ConnectorPermission =
  | "connector.read"
  | "connector.manage"
  | "connector.sync"
  | "connector.action.propose"
  | "connector.action.approve";

const WORKSPACE_ROLE_PERMISSIONS: Record<string, Set<ConnectorPermission>> = {
  workspace_admin: new Set([
    "connector.read",
    "connector.manage",
    "connector.sync",
    "connector.action.propose",
    "connector.action.approve",
  ]),
  editor: new Set([
    "connector.read",
    "connector.sync",
    "connector.action.propose",
  ]),
  viewer: new Set(["connector.read"]),
};

export async function requireConnectorWorkspace(input: {
  workspaceId: string;
  userId: string;
  permission: ConnectorPermission;
}) {
  const workspace = await workspaceService.resolveWorkspace({
    workspaceId: input.workspaceId,
    userId: input.userId,
  });
  if (!workspace) {
    throw new ConnectorError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
  }

  // `resolveWorkspace` has already established content access, so `role` is
  // set here; a container-only administrator never gets this far.
  const access = await workspaceService.resolveAccess({
    workspaceId: input.workspaceId,
    userId: input.userId,
  });
  const membership = access?.role ? { role: access.role } : null;
  const permissions = membership
    ? WORKSPACE_ROLE_PERMISSIONS[membership.role]
    : undefined;

  if (!permissions?.has(input.permission)) {
    throw new ConnectorError(
      403,
      "CONNECTOR_FORBIDDEN",
      "You do not have permission to access connectors in this workspace",
    );
  }

  return { workspace, membership };
}
