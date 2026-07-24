import { config } from "../../shared/config";
import { logger } from "../../shared/logger";
import { teamAuditService } from "../team-audit";
import { workspaceService } from "./service";
import {
  acceptGuestInvitationRecord,
  createGuestInvitationRecord,
  findLiveGuestInvitationByToken,
  listPendingGuestInvitations,
  listWorkspaceGuests,
  removeGuestMembership,
  revokePendingGuestInvitation,
  type GuestRole,
} from "./guest-store";

export type GuestMutationResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; reason: "not_found" | "forbidden" | "invalid_invitation" };

export type WorkspaceGuest = {
  userId: string;
  role: GuestRole;
  name: string | null;
  email: string | null;
  image: string | null;
  createdAt: string;
};

export type PendingGuestInvitation = {
  id: string;
  email: string;
  role: GuestRole;
  createdAt: string;
};

function guestAcceptUrl(token: string) {
  const url = new URL("/guest-invite", config.auth.webBaseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

/**
 * Guest collaboration: invite people from outside the organization into one
 * workspace, without a seat or organization membership. Managing guests is a
 * content-plane admin action — the same bar as managing members — because it
 * hands out access to workspace content.
 */
export class GuestService {
  private async requireWorkspaceAdmin(input: {
    workspaceId: string;
    actorUserId: string;
  }) {
    const access = await workspaceService.resolveAccess({
      workspaceId: input.workspaceId,
      userId: input.actorUserId,
    });
    if (!access || access.role === null) {
      return { ok: false as const, reason: "not_found" as const };
    }
    if (!workspaceService.canAdministerContent(access)) {
      return { ok: false as const, reason: "forbidden" as const };
    }
    return { ok: true as const, organizationId: access.organizationId };
  }

  async inviteGuest(input: {
    workspaceId: string;
    actorUserId: string;
    email: string;
    role: GuestRole;
  }): Promise<GuestMutationResult> {
    const admin = await this.requireWorkspaceAdmin(input);
    if (!admin.ok) {
      return admin;
    }

    const workspace = await workspaceService.findWorkspaceInOrganization({
      workspaceId: input.workspaceId,
      organizationId: admin.organizationId,
    });
    if (!workspace) {
      return { ok: false, reason: "not_found" };
    }

    const invitation = await createGuestInvitationRecord({
      workspaceId: input.workspaceId,
      email: input.email,
      role: input.role,
      invitedBy: input.actorUserId,
      expiresAt: null,
    });

    try {
      const { mailService } = await import("../mail");
      await mailService.sendTemplate({
        to: invitation.email,
        templateId: "workspace.guest-invitation",
        messageType: "workspace.guest-invitation",
        variables: {
          inviterLabel: "A teammate",
          workspaceName: workspace.name,
          url: guestAcceptUrl(invitation.token),
        },
      });
    } catch (error) {
      // The invitation row exists regardless; a mail failure must not fail the
      // request, and the link can be resent.
      logger.error("guest_invitation_email_failed", {
        workspaceId: input.workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await teamAuditService.record({
      teamId: admin.organizationId,
      actorUserId: input.actorUserId,
      action: "workspace.guest_invited",
      targetType: "guest",
      targetId: invitation.email,
      metadata: { workspaceId: input.workspaceId, role: input.role },
    });

    return { ok: true, value: undefined };
  }

  async listGuests(input: { workspaceId: string; userId: string }): Promise<{
    guests: WorkspaceGuest[];
    invitations: PendingGuestInvitation[];
  } | null> {
    const access = await workspaceService.resolveAccess({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });
    if (!access || (access.role === null && !access.isContainerAdmin)) {
      return null;
    }

    const [guests, invitations] = await Promise.all([
      listWorkspaceGuests(input.workspaceId),
      listPendingGuestInvitations(input.workspaceId),
    ]);

    return {
      guests: guests.map((g) => ({
        userId: g.user_id,
        role: g.role as GuestRole,
        name: g.name,
        email: g.email,
        image: g.image,
        createdAt: g.created_at,
      })),
      invitations: invitations.map((inv) => ({
        id: inv.id,
        email: inv.email,
        role: inv.role as GuestRole,
        createdAt: inv.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Accepts an invitation for the signed-in user. Any authenticated account can
   * accept — that is the point of a guest: no organization membership required.
   */
  async acceptInvitation(input: {
    token: string;
    userId: string;
  }): Promise<GuestMutationResult<{ workspaceId: string }>> {
    const invitation = await findLiveGuestInvitationByToken(input.token);
    if (!invitation) {
      return { ok: false, reason: "invalid_invitation" };
    }

    const { workspaceId, organizationId } = await acceptGuestInvitationRecord({
      invitation,
      userId: input.userId,
    });

    if (organizationId) {
      await teamAuditService.record({
        teamId: organizationId,
        actorUserId: input.userId,
        action: "workspace.guest_accepted",
        targetType: "guest",
        targetId: input.userId,
        metadata: { workspaceId },
      });
    }

    return { ok: true, value: { workspaceId } };
  }

  async revokeInvitation(input: {
    workspaceId: string;
    actorUserId: string;
    invitationId: string;
  }): Promise<GuestMutationResult> {
    const admin = await this.requireWorkspaceAdmin(input);
    if (!admin.ok) {
      return admin;
    }

    const revoked = await revokePendingGuestInvitation({
      workspaceId: input.workspaceId,
      invitationId: input.invitationId,
    });
    if (!revoked) {
      return { ok: false, reason: "not_found" };
    }

    await teamAuditService.record({
      teamId: admin.organizationId,
      actorUserId: input.actorUserId,
      action: "workspace.guest_revoked",
      targetType: "guest",
      targetId: input.invitationId,
      metadata: { workspaceId: input.workspaceId },
    });

    return { ok: true, value: undefined };
  }

  async removeGuest(input: {
    workspaceId: string;
    actorUserId: string;
    userId: string;
  }): Promise<GuestMutationResult> {
    const admin = await this.requireWorkspaceAdmin(input);
    if (!admin.ok) {
      return admin;
    }

    const removed = await removeGuestMembership({
      workspaceId: input.workspaceId,
      userId: input.userId,
    });
    if (!removed) {
      return { ok: false, reason: "not_found" };
    }

    await teamAuditService.record({
      teamId: admin.organizationId,
      actorUserId: input.actorUserId,
      action: "workspace.guest_removed",
      targetType: "guest",
      targetId: input.userId,
      metadata: { workspaceId: input.workspaceId },
    });

    return { ok: true, value: undefined };
  }
}

export const guestService = new GuestService();
