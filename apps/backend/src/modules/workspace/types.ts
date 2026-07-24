export type WorkspaceRole = "workspace_admin" | "editor" | "viewer";

/**
 * How a user's content role in a workspace was arrived at.
 *
 * `derived` — no row exists; the role follows from organization membership,
 * which is only the case for the organization's shared default workspace.
 * `explicit` — a `workspace_memberships` row names this user's role.
 * `guest` — a `workspace_memberships` row for someone who is NOT an
 * organization member: an external collaborator invited to this one workspace,
 * with no seat, no organization capabilities, and a role capped at editor.
 *
 * `derived` is computed on every read; `explicit`/`guest` are stored rows.
 */
export type WorkspaceAccessSource = "derived" | "explicit" | "guest";

/** A guest never exceeds editor — they never administer the workspace. */
export function capGuestRole(role: WorkspaceRole): WorkspaceRole {
  return role === "workspace_admin" ? "editor" : role;
}

export type Workspace = {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  isDefault: boolean;
  createdBy: string | null;
  createdAt: string;
};

/**
 * A user's standing in one workspace, across both planes.
 *
 * The planes are deliberately independent:
 *
 * - `role` (content plane) is what the user may read and write *inside* the
 *   workspace. An explicit row can lower it, including for organization
 *   owners — content privacy is not overridable by administrative rank.
 * - `isContainerAdmin` (administration plane) is what the user may do *to* the
 *   workspace: rename it, configure its credentials, manage its members. It
 *   follows from the organization role and cannot be lowered, which is what
 *   makes a workspace with no administrator unreachable as a state.
 *
 * The invariant tying them together: a container admin may perform any
 * operation that does not *increase* someone's content access. Granting or
 * raising a content role requires being a content-plane admin.
 */
export type WorkspaceAccess = {
  workspaceId: string;
  organizationId: string;
  userId: string;
  organizationRole: string;
  /** Content role, or null when the user has no content access at all. */
  role: WorkspaceRole | null;
  source: WorkspaceAccessSource | null;
  isContainerAdmin: boolean;
};

export type WorkspaceMember = {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  source: WorkspaceAccessSource;
  organizationRole: string;
  name: string | null;
  email: string | null;
  image: string | null;
};

export type OrganizationMembership = {
  organizationId: string;
  userId: string;
  role: string;
  createdAt: string;
};

const WORKSPACE_ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 0,
  editor: 1,
  workspace_admin: 2,
};

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return (
    value === "workspace_admin" || value === "editor" || value === "viewer"
  );
}

/** True when `role` is at least as privileged as `minimum`. */
export function workspaceRoleSatisfies(
  role: WorkspaceRole,
  minimum: WorkspaceRole,
) {
  return WORKSPACE_ROLE_RANK[role] >= WORKSPACE_ROLE_RANK[minimum];
}

/** Organization owners and admins administer every workspace they own. */
export function isOrganizationAdminRole(organizationRole: string) {
  const roles = organizationRole.split(",").map((part) => part.trim());
  return roles.includes("owner") || roles.includes("admin");
}

/**
 * Default content role in the shared workspace, before any explicit override.
 * Organization admins start as workspace admins; plain members can author but
 * not change who else is in the room.
 */
export function defaultContentRoleForOrganizationRole(
  organizationRole: string,
): WorkspaceRole {
  return isOrganizationAdminRole(organizationRole)
    ? "workspace_admin"
    : "editor";
}

/** Content role a user ends up with, given the derived default and any override. */
export function resolveContentRole(input: {
  organizationRole: string;
  isDefaultWorkspace: boolean;
  overrideRole: WorkspaceRole | null;
}): { role: WorkspaceRole | null; source: WorkspaceAccessSource | null } {
  // An override wins outright, in both directions. This is the whole of the
  // "explicit beats inherited" rule: an organization owner who was made a
  // viewer here is a viewer here.
  if (input.overrideRole) {
    return { role: input.overrideRole, source: "explicit" };
  }

  if (input.isDefaultWorkspace) {
    return {
      role: defaultContentRoleForOrganizationRole(input.organizationRole),
      source: "derived",
    };
  }

  // Any other workspace is invitation-only: being in the organization is not
  // by itself a reason to be in someone's project space.
  return { role: null, source: null };
}
