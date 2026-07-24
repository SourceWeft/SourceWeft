import {
  createPersonalOrganizationForUser,
  createTeamOrganizationForUser,
  createWorkspaceRecord,
  deleteOrganizationWorkspaceMemberships,
  deleteWorkspaceMembershipRecord,
  ensureSharedWorkspaceRecord,
  ensureUserWorkspaceInOrganizationRecord,
  findOrganizationById,
  findOrganizationMembership,
  findPersonalOrganizationMembershipByUser,
  findWorkspaceByIdForMember,
  findWorkspaceByIdInOrganization,
  findWorkspaceMembershipOverride,
  isOrganizationMember,
  listWorkspaceMemberRecords,
  listWorkspacesForMember,
  resolveWorkspaceAccessRecord,
  updateWorkspaceNameRecord,
  upsertWorkspaceMembershipOverride,
} from "./store";
import { isPersonalOrganizationMetadata } from "../auth/organization-metadata";
import { teamAuditService } from "../team-audit";
import {
  isOrganizationAdminRole,
  workspaceRoleSatisfies,
  type Workspace,
  type WorkspaceAccess,
  type WorkspaceRole,
} from "./types";

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

export type WorkspaceMemberMutationResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "forbidden" };

type MutationFailure = Extract<WorkspaceMemberMutationResult, { ok: false }>;

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

    // A newly created workspace is not the shared one, so nobody is in it by
    // derivation — the creator needs a real row. Organization admins can
    // administer it without being in it; that is the point of the two planes.
    await upsertWorkspaceMembershipOverride({
      workspaceId: workspace.id,
      userId: input.userId,
      role: "workspace_admin",
    });

    await teamAuditService.record({
      teamId: input.organizationId,
      actorUserId: input.userId,
      action: "workspace.created",
      targetType: "workspace",
      targetId: workspace.id,
      metadata: { name: workspace.name, slug: workspace.slug },
    });

    return workspace;
  }

  async listWorkspaces(input: { organizationId: string; userId: string }) {
    return listWorkspacesForMember(input);
  }

  async ensureUserWorkspaceInOrganization(input: {
    organizationId: string;
    userId: string;
  }) {
    const name = "My Workspace";
    return ensureUserWorkspaceInOrganizationRecord({
      organizationId: input.organizationId,
      userId: input.userId,
      name,
      primarySlug: slugify(name) || "workspace",
    });
  }

  /**
   * Makes sure the organization has somewhere for this user to work.
   *
   * Personal organizations keep one workspace per user. Team organizations get
   * a single shared default workspace — and notably this does *not* enroll
   * anyone: membership of that workspace follows from organization membership,
   * so every current and future teammate is already in it the moment it
   * exists. That is what removes the backfill problem rather than deferring it.
   */
  async ensureMembershipWorkspace(input: {
    organizationId: string;
    userId: string;
  }): Promise<Workspace> {
    const organization = await findOrganizationById(input.organizationId);

    if (
      !organization ||
      isPersonalOrganizationMetadata(organization.metadata)
    ) {
      return this.ensureUserWorkspaceInOrganization(input);
    }

    const name = organization.name?.trim() || "Team Workspace";
    return ensureSharedWorkspaceRecord({
      organizationId: input.organizationId,
      name,
      primarySlug: slugify(name) || "team",
      createdBy: input.userId,
    });
  }

  async ensureDefaultWorkspace(input: {
    organizationId: string;
    userId: string;
  }) {
    return this.ensureMembershipWorkspace(input);
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

    const access = await this.resolveAccess(input);

    if (!access) {
      return null;
    }

    // Renaming is a container operation, so an organization admin may do it to
    // a workspace whose contents they cannot read.
    if (!this.canAdministerContainer(access)) {
      return "forbidden" as const;
    }

    const workspace = await updateWorkspaceNameRecord({
      workspaceId: input.workspaceId,
      name,
    });

    if (workspace) {
      await teamAuditService.record({
        teamId: workspace.organizationId,
        actorUserId: input.userId,
        action: "workspace.renamed",
        targetType: "workspace",
        targetId: workspace.id,
        metadata: { name: workspace.name },
      });
    }

    return workspace;
  }

  async resolveWorkspace(input: { workspaceId: string; userId: string }) {
    return findWorkspaceByIdForMember(input);
  }

  /** Both planes for one user in one workspace. Null when outside the org. */
  async resolveAccess(input: {
    workspaceId: string;
    userId: string;
  }): Promise<WorkspaceAccess | null> {
    return resolveWorkspaceAccessRecord(input);
  }

  /** Administers the container: rename, credentials, membership, audit. */
  canAdministerContainer(access: WorkspaceAccess) {
    return (
      access.isContainerAdmin ||
      (access.role !== null &&
        workspaceRoleSatisfies(access.role, "workspace_admin"))
    );
  }

  /**
   * Admin *inside* the workspace. Required for anything that hands out or
   * raises content access, which a container admin deliberately cannot do:
   * otherwise an organization owner could grant themselves into a workspace
   * whose privacy the content plane is supposed to guarantee.
   */
  canAdministerContent(access: WorkspaceAccess) {
    return (
      access.role !== null &&
      workspaceRoleSatisfies(access.role, "workspace_admin")
    );
  }

  async listWorkspaceMembers(input: { workspaceId: string; userId: string }) {
    const access = await this.resolveAccess(input);
    if (!access) {
      return null;
    }

    if (access.role === null && !access.isContainerAdmin) {
      return null;
    }

    const workspace = await findWorkspaceByIdInOrganization({
      workspaceId: input.workspaceId,
      organizationId: access.organizationId,
    });

    if (!workspace) {
      return null;
    }

    return listWorkspaceMemberRecords({
      workspaceId: workspace.id,
      organizationId: workspace.organizationId,
      isDefaultWorkspace: workspace.isDefault,
    });
  }

  async addWorkspaceMember(input: {
    workspaceId: string;
    actorUserId: string;
    userId: string;
    role: WorkspaceRole;
  }): Promise<WorkspaceMemberMutationResult> {
    const actor = await this.requireContentAdmin(input);
    if ("reason" in actor) {
      return actor;
    }

    // A workspace never reaches outside its organization: adding someone grants
    // access to a seat that already exists, it does not create one.
    const target = await findOrganizationMembership({
      organizationId: actor.organizationId,
      userId: input.userId,
    });

    if (!target) {
      return { ok: false, reason: "not_found" };
    }

    await upsertWorkspaceMembershipOverride({
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
    });

    await teamAuditService.record({
      teamId: actor.organizationId,
      actorUserId: input.actorUserId,
      action: "workspace.member_added",
      targetType: "workspace_member",
      targetId: input.userId,
      metadata: { workspaceId: input.workspaceId, role: input.role },
    });

    return { ok: true };
  }

  async updateWorkspaceMemberRole(input: {
    workspaceId: string;
    actorUserId: string;
    userId: string;
    role: WorkspaceRole;
  }): Promise<WorkspaceMemberMutationResult> {
    const actor = await this.requireContentAdmin(input);
    if ("reason" in actor) {
      return actor;
    }

    const target = await this.resolveAccess({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    // No derived and no explicit standing means there is nothing to re-grade;
    // `addWorkspaceMember` is the endpoint for letting someone in.
    if (!target || target.role === null) {
      return { ok: false, reason: "not_found" };
    }

    const previousRole = target.role;

    await upsertWorkspaceMembershipOverride({
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
    });

    await teamAuditService.record({
      teamId: actor.organizationId,
      actorUserId: input.actorUserId,
      action: "workspace.member_role_changed",
      targetType: "workspace_member",
      targetId: input.userId,
      metadata: {
        workspaceId: input.workspaceId,
        from: previousRole,
        to: input.role,
        // Worth recording: an organization admin graded down to viewer here
        // still administers the container, and the audit trail should not
        // read as though they lost that.
        retainsContainerAdmin: target.isContainerAdmin,
      },
    });

    return { ok: true };
  }

  async removeWorkspaceMember(input: {
    workspaceId: string;
    actorUserId: string;
    userId: string;
  }): Promise<WorkspaceMemberMutationResult> {
    const access = await this.resolveAccess({
      workspaceId: input.workspaceId,
      userId: input.actorUserId,
    });

    if (!access) {
      return { ok: false, reason: "not_found" };
    }

    // Removal only ever reduces access, so a container admin may do it.
    if (!this.canAdministerContainer(access)) {
      return { ok: false, reason: "forbidden" };
    }

    const target = await this.resolveAccess({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    if (!target || target.role === null) {
      return { ok: false, reason: "not_found" };
    }

    if (target.source === "derived") {
      // Derived membership cannot be deleted, only overridden — and dropping
      // someone out of the shared workspace entirely has no representation in
      // this model. Removing them from the organization is the honest action;
      // grading them to viewer is the softer one.
      return { ok: false, reason: "forbidden" };
    }

    await deleteWorkspaceMembershipRecord({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    await teamAuditService.record({
      teamId: access.organizationId,
      actorUserId: input.actorUserId,
      action: "workspace.member_removed",
      targetType: "workspace_member",
      targetId: input.userId,
      metadata: { workspaceId: input.workspaceId, role: target.role },
    });

    return { ok: true };
  }

  /**
   * Clears a departing member's overrides. Derived access is already gone with
   * their `member` row, so this only keeps the stored data honest.
   */
  async revokeOrganizationWorkspaceAccess(input: {
    organizationId: string;
    userId: string;
    actorUserId?: string | null;
  }) {
    const workspaceIds = await deleteOrganizationWorkspaceMemberships({
      organizationId: input.organizationId,
      userId: input.userId,
    });

    await teamAuditService.record({
      teamId: input.organizationId,
      actorUserId: input.actorUserId ?? null,
      action: "organization.member_removed",
      targetType: "member",
      targetId: input.userId,
      metadata: { clearedOverrideWorkspaceIds: workspaceIds },
    });

    return workspaceIds;
  }

  async getWorkspaceMembershipOverride(input: {
    workspaceId: string;
    userId: string;
  }) {
    return findWorkspaceMembershipOverride(input);
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

  async isOrganizationAdmin(input: { organizationId: string; userId: string }) {
    const membership = await findOrganizationMembership(input);
    return Boolean(membership && isOrganizationAdminRole(membership.role));
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

  async findPersonalOrganizationMembershipByUser(userId: string) {
    return findPersonalOrganizationMembershipByUser(userId);
  }

  private async requireContentAdmin(input: {
    workspaceId: string;
    actorUserId: string;
  }): Promise<WorkspaceAccess | MutationFailure> {
    const access = await this.resolveAccess({
      workspaceId: input.workspaceId,
      userId: input.actorUserId,
    });

    if (!access || access.role === null) {
      return { ok: false, reason: "not_found" };
    }

    if (!this.canAdministerContent(access)) {
      return { ok: false, reason: "forbidden" };
    }

    return access;
  }
}

export const workspaceService = new WorkspaceService();
