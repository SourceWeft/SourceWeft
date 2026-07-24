import { createHash, randomBytes, randomUUID } from "node:crypto";
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
 * The `token` column stores a sha256 hex digest, never the raw secret: the
 * invite link is emailed once and never re-displayed, so the raw token need not
 * survive at rest. Accept hashes the presented token and looks it up by digest.
 */
function hashGuestToken(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Creates a pending guest invitation, or reuses the existing live one for the
 * same (workspace, email). The partial unique index is the backstop.
 *
 * Returns the RAW token alongside the row so the caller can build the mailed
 * link; only its hash is persisted, so the raw is unrecoverable afterwards —
 * reusing an existing invitation therefore rotates the token to a fresh one.
 */
export async function createGuestInvitationRecord(input: {
  workspaceId: string;
  email: string;
  role: GuestRole;
  invitedBy: string;
  expiresAt: Date | null;
}): Promise<{ invitation: GuestInvitationRow; token: string }> {
  const email = input.email.trim().toLowerCase();
  const rawToken = generateGuestToken();
  const tokenHash = hashGuestToken(rawToken);

  const existing = await findPendingInvitation(input.workspaceId, email);
  if (existing) {
    // A live invitation already exists. Rotate its stored hash to the freshly
    // minted token so the (re)sent link resolves — the previously mailed raw
    // token cannot be recovered from its digest.
    const [rotated] = await db
      .update(workspaceGuestInvitations)
      .set({ token: tokenHash, expiresAt: input.expiresAt })
      .where(eq(workspaceGuestInvitations.id, existing.id))
      .returning();
    return { invitation: rotated ?? existing, token: rawToken };
  }

  const [row] = await db
    .insert(workspaceGuestInvitations)
    .values({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      email,
      role: input.role,
      token: tokenHash,
      status: "pending",
      invitedBy: input.invitedBy,
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing()
    .returning();

  if (row) {
    return { invitation: row, token: rawToken };
  }

  // Lost a race to a concurrent insert: adopt the winning row and rotate its
  // hash to the token we just minted so the caller's mailed link resolves.
  const found = (await findPendingInvitation(input.workspaceId, email))!;
  const [rotated] = await db
    .update(workspaceGuestInvitations)
    .set({ token: tokenHash })
    .where(eq(workspaceGuestInvitations.id, found.id))
    .returning();
  return { invitation: rotated ?? found, token: rawToken };
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
  // The column stores a hash; look up by the digest of the presented token.
  const tokenHash = hashGuestToken(token);
  const [row] = await db
    .select()
    .from(workspaceGuestInvitations)
    .where(
      and(
        eq(workspaceGuestInvitations.token, tokenHash),
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
        // Only touch a row that is itself a guest grant. If the accepting user
        // already holds a real membership (a source='direct' admin override, or
        // an inherited/derived row), accepting a guest invite must NOT overwrite
        // it — that would silently downgrade a member to editor and let a later
        // "remove guest" (deletes WHERE source='guest') delete their real
        // standing. setWhere leaves the existing non-guest row untouched.
        setWhere: sql`${workspaceMemberships.source} = 'guest'`,
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
