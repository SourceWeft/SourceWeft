export type WorkspaceRole = "workspace_admin" | "editor" | "viewer";

export type Workspace = {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  createdBy: string;
  createdAt: string;
};

export type WorkspaceMembership = {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  createdAt: string;
};

export type OrganizationMembership = {
  organizationId: string;
  userId: string;
  role: string;
  createdAt: string;
};
