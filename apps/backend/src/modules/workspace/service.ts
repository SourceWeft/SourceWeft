import {
  createPersonalOrganizationForUser,
  createTeamOrganizationForUser,
  createWorkspaceRecord,
  ensureWorkspaceMembership,
  findMembershipByUser,
  findOrganizationById,
  findOrganizationMembership,
  findPersonalOrganizationMembershipByUser,
  findWorkspaceByIdForMember,
  findWorkspaceByIdInOrganization,
  findWorkspaceMembership,
  isOrganizationMember,
  listWorkspacesForMember,
  updateWorkspaceNameRecord,
} from "./store";
import type { Workspace } from "./types";

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function uniqueSlug(base: string) {
  const normalized = slugify(base) || "workspace";
  return `${normalized}-${Math.random().toString(36).slice(2, 8)}`;
}

type CreateWorkspaceInput = {
  organizationId: string;
  userId: string;
  name: string;
};

export class WorkspaceService {
  async createWorkspace(input: CreateWorkspaceInput) {
    const name = input.name.trim();
    if (!name) {
      throw new Error("Workspace name is required");
    }

    const primarySlug = slugify(name) || "workspace";

    let workspace: Workspace;
    try {
      workspace = await createWorkspaceRecord({
        organizationId: input.organizationId,
        name,
        slug: primarySlug,
        createdBy: input.userId,
      });
    } catch (error) {
      const pgError = error as { code?: string };
      if (pgError.code !== "23505") {
        throw error;
      }

      workspace = await createWorkspaceRecord({
        organizationId: input.organizationId,
        name,
        slug: uniqueSlug(name),
        createdBy: input.userId,
      });
    }

    await ensureWorkspaceMembership({
      workspaceId: workspace.id,
      userId: input.userId,
      role: "workspace_admin",
    });

    return workspace;
  }

  async listWorkspaces(input: { organizationId: string; userId: string }) {
    return listWorkspacesForMember(input);
  }

  async ensureDefaultWorkspace(input: {
    organizationId: string;
    userId: string;
  }) {
    return this.createWorkspace({
      organizationId: input.organizationId,
      userId: input.userId,
      name: "My Workspace",
    });
  }

  async updateWorkspaceName(input: {
    workspaceId: string;
    name: string;
    userId: string;
  }) {
    const name = input.name.trim();
    if (!name) {
      throw new Error("Workspace name is required");
    }

    const membership = await findWorkspaceMembership({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    if (!membership) {
      return null;
    }

    if (membership.role !== "workspace_admin") {
      return "forbidden" as const;
    }

    return updateWorkspaceNameRecord({
      workspaceId: input.workspaceId,
      name,
    });
  }

  async resolveWorkspace(input: { workspaceId: string; userId: string }) {
    return findWorkspaceByIdForMember(input);
  }

  async getWorkspaceMembership(input: { workspaceId: string; userId: string }) {
    return findWorkspaceMembership(input);
  }

  async findWorkspaceInOrganization(input: {
    workspaceId: string;
    organizationId: string;
  }) {
    return findWorkspaceByIdInOrganization(input);
  }

  async getOrganizationMembership(input: {
    organizationId: string;
    userId: string;
  }) {
    return findOrganizationMembership(input);
  }

  async getOrganization(organizationId: string) {
    return findOrganizationById(organizationId);
  }

  async createPersonalOrganization(input: {
    name: string;
    slug: string;
    userId: string;
    metadata: Record<string, unknown>;
  }) {
    return createPersonalOrganizationForUser(input);
  }

  async createTeamOrganization(input: {
    name: string;
    slug: string;
    userId: string;
    metadata: Record<string, unknown>;
    idempotencyKey: string;
  }) {
    return createTeamOrganizationForUser(input);
  }

  async hasOrganizationMembership(input: {
    organizationId: string;
    userId: string;
  }) {
    return isOrganizationMember(input);
  }

  async findAnyMembershipByUser(userId: string) {
    return findMembershipByUser(userId);
  }

  async findPersonalOrganizationMembershipByUser(userId: string) {
    return findPersonalOrganizationMembershipByUser(userId);
  }
}

export const workspaceService = new WorkspaceService();
