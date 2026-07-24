import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  workspaceGuestInvitations,
  workspaceMemberships,
} from "@sourceweft/db";
import type { WorkspaceRole } from "./types";

export type GuestInvitationRow = typeof workspaceGuestInvitations.$inferSelect;

/** Guest role is viewer or editor only — a guest never administers a workspace. */
export type GuestRole = Extract<WorkspaceRole, "editor" | "viewer">;

function generateGuestToken() {
  return randomBytes(24).toString("base64url");
}

/**
 * Creates a pending guest invitation, or returns the existing live one for the
 * same (workspace, email). The partial unique index is the backstop.
 */
export async function createGuestInvitationRecord(input: {
  workspaceId: string;
  email: string;
  role: GuestRole;
  invitedBy: string;
  expiresAt: Date | null;
}): Promise<GuestInvitationRow> {
  const email = input.email.trim().toLowerCase();
  const existing = await findPendingInvitation(input.workspaceId, email);
  if (existing) {
    return existing;
  }

  const [row] = await db
    .insert(workspaceGuestInvitations)
    .values({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      email,
      role: input.role,
      token: generateGuestToken(),
      status: "pending",
      invitedBy: input.invitedBy,
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing()
    .returning();

  return row ?? (await findPendingInvitation(input.workspaceId, email))!;
}

async function findPendingInvitation(workspaceId: string, email: string) {
  const [row] = await db
    .select()
    .from(workspaceGuestInvitations)
    .where(
      and(
        eq(workspaceGuestInvitations.workspaceId, workspaceId),
        eq(workspaceGuestInvitations.email, email),
        eq(workspaceGuestInvitations.status, "pending"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** A pending, unexpired invitation resolved by its token — the accept path. */
export async function findLiveGuestInvitationByToken(token: string) {
  const [row] = await db
    .select()
    .from(workspaceGuestInvitations)
    .where(
      and(
        eq(workspaceGuestInvitations.token, token),
        eq(workspaceGuestInvitations.status, "pending"),
        sql`(${workspaceGuestInvitations.expiresAt} is null or ${workspaceGuestInvitations.expiresAt} > now())`,
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listPendingGuestInvitations(workspaceId: string) {
  return db
    .select()
    .from(workspaceGuestInvitations)
    .where(
      and(
        eq(workspaceGuestInvitations.workspaceId, workspaceId),
        eq(workspaceGuestInvitations.status, "pending"),
      ),
    );
}

type GuestMemberRow = {
  user_id: string;
  role: WorkspaceRole;
  created_at: string;
  name: string | null;
  email: string | null;
  image: string | null;
};

/** Accepted guests (source='guest' memberships) with their user details. */
export async function listWorkspaceGuests(workspaceId: string) {
  const result = await db.execute<GuestMemberRow>(sql`
    select
      wm.user_id,
      wm.role,
      wm.created_at::text as created_at,
      u.name,
      u.email,
      u.image
    from workspace_memberships wm
    left join "user" u on u.id = wm.user_id
    where wm.workspace_id = ${workspaceId}
      and wm.source = 'guest'
    order by wm.created_at asc
  `);
  return result.rows ?? [];
}

/**
 * Accepts an invitation for a signed-in user: marks it accepted and grants the
 * guest membership in one transaction. Idempotent on the membership so a
 * double-accept is harmless.
 */
export async function acceptGuestInvitationRecord(input: {
  invitation: GuestInvitationRow;
  userId: string;
}) {
  return db.transaction(async (tx) => {
    await tx
      .update(workspaceGuestInvitations)
      .set({ status: "accepted", acceptedUserId: input.userId })
      .where(eq(workspaceGuestInvitations.id, input.invitation.id));

    await tx
      .insert(workspaceMemberships)
      .values({
        workspaceId: input.invitation.workspaceId,
        userId: input.userId,
        role: input.invitation.role,
        source: "guest",
      })
      .onConflictDoUpdate({
        target: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
        set: { role: input.invitation.role, source: "guest" },
      });

    const orgResult = await tx.execute<{ organization_id: string }>(sql`
      select organization_id from workspaces where id = ${input.invitation.workspaceId} limit 1
    `);

    return {
      workspaceId: input.invitation.workspaceId,
      organizationId: orgResult.rows?.[0]?.organization_id ?? null,
    };
  });
}

export async function revokePendingGuestInvitation(input: {
  workspaceId: string;
  invitationId: string;
}) {
  const rows = await db
    .update(workspaceGuestInvitations)
    .set({ status: "revoked" })
    .where(
      and(
        eq(workspaceGuestInvitations.id, input.invitationId),
        eq(workspaceGuestInvitations.workspaceId, input.workspaceId),
        eq(workspaceGuestInvitations.status, "pending"),
      ),
    )
    .returning({ id: workspaceGuestInvitations.id });
  return rows.length > 0;
}

/** Removes an accepted guest's access (deletes only the guest membership row). */
export async function removeGuestMembership(input: {
  workspaceId: string;
  userId: string;
}) {
  const rows = await db
    .delete(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, input.workspaceId),
        eq(workspaceMemberships.userId, input.userId),
        eq(workspaceMemberships.source, "guest"),
      ),
    )
    .returning({ userId: workspaceMemberships.userId });
  return rows.length > 0;
}
