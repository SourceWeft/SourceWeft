import {
  createOrganizationRecord,
  createWorkspaceRecord,
  ensureWorkspaceMembership,
  addMemberRecord,
  findFirstWorkspaceByOrganization,
  findOrganizationMembership,
  findWorkspaceByIdInOrganization,
  findWorkspaceByIdForMember,
  isOrganizationMember,
  listWorkspacesForMember,
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
    const existing = await findFirstWorkspaceByOrganization({
      organizationId: input.organizationId,
    });

    if (existing) {
      await ensureWorkspaceMembership({
        workspaceId: existing.id,
        userId: input.userId,
        role: "workspace_admin",
      });
      return existing;
    }

    return this.createWorkspace({
      organizationId: input.organizationId,
      userId: input.userId,
      name: "General",
    });
  }

  async resolveWorkspace(input: { workspaceId: string; userId: string }) {
    return findWorkspaceByIdForMember(input);
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

  async hasOrganizationMembership(input: {
    organizationId: string;
    userId: string;
  }) {
    return isOrganizationMember(input);
  }

  async ensurePersonalTeamForUser(userId: string) {
    const { randomUUID } = await import("node:crypto");
    const personalOrgId = randomUUID();
    const personalOrgSlug = `personal-${personalOrgId.slice(0, 8)}`;

    await createOrganizationRecord({
      id: personalOrgId,
      name: "Personal",
      slug: personalOrgSlug,
    });

    await addMemberRecord({
      organizationId: personalOrgId,
      userId,
      role: "owner",
    });

    await this.ensureDefaultWorkspace({
      organizationId: personalOrgId,
      userId,
    });

    return { organizationId: personalOrgId };
  }
}

export const workspaceService = new WorkspaceService();
