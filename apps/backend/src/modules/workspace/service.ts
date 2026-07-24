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

  /**
   * 谁问谁付 — a guest's runs bill the guest's own personal org, not the host
   * team; members bill the workspace's org.
   *
   * Whoever initiates a run pays from their own account. A guest is not an
   * organization member, so charging the host team for their run would be the
   * host silently footing an outsider's bill. Members (derived/explicit
   * standing) keep billing the workspace's owning org, unchanged.
   *
   * The fallback to `workspaceOrganizationId` is deliberate: a run must never be
   * left unbilled or made to error over a missing personal org, so if the guest
   * somehow has no personal organization we settle against the workspace's org.
   */
  async resolveBillingOrganizationId(input: {
    workspaceId: string;
    userId: string;
    workspaceOrganizationId: string;
  }): Promise<string> {
    const access = await this.resolveAccess({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });

    if (access?.source === "guest") {
      const personal = await this.findPersonalOrganizationMembershipByUser(
        input.userId,
      );
      return personal?.organizationId ?? input.workspaceOrganizationId;
    }

    return input.workspaceOrganizationId;
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

  /**
   * True when the target user is the ONLY content `workspace_admin` of a
   * NON-default workspace. Demoting or removing them would leave that workspace
   * with no content administrator, and — unlike the shared default workspace,
   * where an organization owner/admin is always a derived content admin —
   * nothing backstops a private workspace's content plane (a container admin
   * deliberately cannot administer content). There is also no workspace-delete
   * endpoint, so the workspace would be permanently unmanageable. The default
   * workspace is exempt (its derived admins always exist).
   */
  private async wouldOrphanContentAdmin(input: {
    workspaceId: string;
    organizationId: string;
    targetUserId: string;
  }): Promise<boolean> {
    const workspace = await findWorkspaceByIdInOrganization({
      workspaceId: input.workspaceId,
      organizationId: input.organizationId,
    });
    if (!workspace || workspace.isDefault) {
      return false;
    }

    const members = await listWorkspaceMemberRecords({
      workspaceId: workspace.id,
      organizationId: workspace.organizationId,
      isDefaultWorkspace: workspace.isDefault,
    });
    const admins = members.filter(
      (member) => member.role === "workspace_admin",
    );
    return admins.length === 1 && admins[0]?.userId === input.targetUserId;
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

    // A guest is not a member: their access is a source='guest' grant managed
    // solely through GuestService. Grading one here would write a source='direct'
    // override that escapes the guest cap and the guest-removal path, so refuse.
    if (target.source === "guest") {
      return { ok: false, reason: "forbidden" };
    }

    const previousRole = target.role;

    // Refuse to demote the last content admin of a private workspace, which
    // would strand it with no one able to administer its content (see
    // wouldOrphanContentAdmin). Break-glass recovery is appointWorkspaceContentAdmin.
    if (
      previousRole === "workspace_admin" &&
      input.role !== "workspace_admin" &&
      (await this.wouldOrphanContentAdmin({
        workspaceId: input.workspaceId,
        organizationId: actor.organizationId,
        targetUserId: input.userId,
      }))
    ) {
      return { ok: false, reason: "forbidden" };
    }

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

    // Removing the last content admin of a private workspace would strand it
    // (see wouldOrphanContentAdmin) — refuse; recover via appointment.
    if (
      target.role === "workspace_admin" &&
      (await this.wouldOrphanContentAdmin({
        workspaceId: input.workspaceId,
        organizationId: access.organizationId,
        targetUserId: input.userId,
      }))
    ) {
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
   * Break-glass recovery for the wouldOrphanContentAdmin invariant: a container
   * admin (org owner/admin) may appoint a content `workspace_admin` on a
   * NON-default workspace that currently has zero content admins. This is the
   * one place a container admin is allowed to grant content access, and only to
   * un-strand an orphaned private workspace — never to reach into a workspace
   * that still has an administrator (that path is normal member management,
   * which a container admin who isn't a content admin cannot use).
   */
  async appointWorkspaceContentAdmin(input: {
    workspaceId: string;
    actorUserId: string;
    userId: string;
  }): Promise<WorkspaceMemberMutationResult> {
    const actorAccess = await this.resolveAccess({
      workspaceId: input.workspaceId,
      userId: input.actorUserId,
    });
    if (!actorAccess) {
      return { ok: false, reason: "not_found" };
    }
    if (!this.canAdministerContainer(actorAccess)) {
      return { ok: false, reason: "forbidden" };
    }

    const workspace = await findWorkspaceByIdInOrganization({
      workspaceId: input.workspaceId,
      organizationId: actorAccess.organizationId,
    });
    if (!workspace) {
      return { ok: false, reason: "not_found" };
    }

    const members = await listWorkspaceMemberRecords({
      workspaceId: workspace.id,
      organizationId: workspace.organizationId,
      isDefaultWorkspace: workspace.isDefault,
    });
    const hasContentAdmin = members.some(
      (member) => member.role === "workspace_admin",
    );
    // Only usable when the content plane is genuinely orphaned. The default
    // workspace always has derived admins, so it never qualifies.
    if (workspace.isDefault || hasContentAdmin) {
      return { ok: false, reason: "forbidden" };
    }

    // The appointee must already belong to the organization — appointment grants
    // a role, it never reaches outside the org (mirrors addWorkspaceMember).
    const target = await findOrganizationMembership({
      organizationId: actorAccess.organizationId,
      userId: input.userId,
    });
    if (!target) {
      return { ok: false, reason: "not_found" };
    }

    await upsertWorkspaceMembershipOverride({
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: "workspace_admin",
    });

    await teamAuditService.record({
      teamId: actorAccess.organizationId,
      actorUserId: input.actorUserId,
      action: "workspace.member_role_changed",
      targetType: "workspace_member",
      targetId: input.userId,
      metadata: {
        workspaceId: input.workspaceId,
        to: "workspace_admin",
        breakGlass: true,
        reason: "orphaned_content_admin_recovery",
      },
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
