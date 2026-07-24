import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, workspaceMemberships, workspaces } from "@sourceweft/db";
import {
  capGuestRole,
  isOrganizationAdminRole,
  resolveContentRole,
  type Workspace,
  type WorkspaceAccess,
  type WorkspaceMember,
  type WorkspaceRole,
} from "./types";

const workspaceColumns = {
  id: workspaces.id,
  organizationId: workspaces.organizationId,
  name: workspaces.name,
  slug: workspaces.slug,
  isDefault: workspaces.isDefault,
  createdBy: workspaces.createdBy,
  createdAt: workspaces.createdAt,
};

type WorkspaceRow = Pick<
  typeof workspaces.$inferSelect,
  | "id"
  | "organizationId"
  | "name"
  | "slug"
  | "isDefault"
  | "createdBy"
  | "createdAt"
>;
type OrganizationMembershipRow = {
  organization_id: string;
  user_id: string;
  role: string;
  created_at: string;
};
type OrganizationRow = {
  id: string;
  name: string;
  slug: string;
  metadata: unknown;
  created_at: string;
};

function mapWorkspaceRow(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    slug: row.slug,
    isDefault: row.isDefault,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function createWorkspaceRecord(input: {
  organizationId: string;
  name: string;
  slug: string;
  createdBy: string;
}) {
  const id = randomUUID();
  const [row] = await db
    .insert(workspaces)
    .values({
      id,
      organizationId: input.organizationId,
      name: input.name,
      slug: input.slug,
      createdBy: input.createdBy,
    })
    .returning();

  if (!row) {
    throw new Error("Failed to create workspace");
  }

  return mapWorkspaceRow(row);
}

export async function updateWorkspaceNameRecord(input: {
  workspaceId: string;
  name: string;
}) {
  const [row] = await db
    .update(workspaces)
    .set({
      name: input.name,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, input.workspaceId))
    .returning();

  if (!row) {
    return null;
  }

  return mapWorkspaceRow(row);
}

/**
 * Writes an explicit content-role override.
 *
 * Every row in `workspace_memberships` is now an override — a deliberate
 * statement that this user's role here differs from, or exists independently
 * of, what the organization implies. Roles that merely follow from
 * organization membership are computed on read and never stored, which is why
 * there is nothing here to keep in sync.
 */
export async function upsertWorkspaceMembershipOverride(input: {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}) {
  const [row] = await db
    .insert(workspaceMemberships)
    .values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
      source: "direct",
    })
    .onConflictDoUpdate({
      target: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
      set: { role: input.role, source: "direct" },
    })
    .returning();

  if (!row) {
    throw new Error("Failed to write workspace membership override");
  }

  return { workspaceId: row.workspaceId, userId: row.userId, role: row.role };
}

type ListedWorkspaceRow = {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  is_default: boolean;
  created_by: string | null;
  created_at: string;
};

/**
 * Workspaces the user can actually enter: the organization's shared default
 * one, plus any other workspace holding an explicit row for them.
 *
 * The `member` join is the access check, not a filter added on top of one —
 * losing organization membership removes every workspace from this list on the
 * next request, with no cleanup pass in between.
 *
 * Note this is the *content* plane. An organization admin does not see
 * teammates' private workspaces here even though they may administer them;
 * listing them as somewhere to go would misrepresent what they can read.
 */
export async function listWorkspacesForMember(input: {
  organizationId: string;
  userId: string;
}) {
  const result = await db.execute<ListedWorkspaceRow>(sql`
    select
      w.id,
      w.organization_id,
      w.name,
      w.slug,
      w.is_default,
      w.created_by,
      w.created_at::text as created_at
    from workspaces w
    join member m
      on m."organizationId" = w.organization_id
     and m."userId" = ${input.userId}
    left join workspace_memberships wm
      on wm.workspace_id = w.id
     and wm.user_id = ${input.userId}
    where w.organization_id = ${input.organizationId}
      and (w.is_default or wm.user_id is not null)
    order by w.created_at asc
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    slug: row.slug,
    isDefault: row.is_default,
    createdBy: row.created_by,
    createdAt: row.created_at,
  })) satisfies Workspace[];
}

export async function ensureUserWorkspaceInOrganizationRecord(input: {
  organizationId: string;
  userId: string;
  name: string;
  primarySlug: string;
}) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtext('sourceweft:user-workspace'),
        hashtext(${`${input.organizationId}:${input.userId}`})
      )
    `);

    const [existing] = await tx
      .select(workspaceColumns)
      .from(workspaces)
      .innerJoin(
        workspaceMemberships,
        eq(workspaceMemberships.workspaceId, workspaces.id),
      )
      .where(
        and(
          eq(workspaces.organizationId, input.organizationId),
          eq(workspaceMemberships.userId, input.userId),
        ),
      )
      .orderBy(asc(workspaces.createdAt))
      .limit(1);

    if (existing) {
      return mapWorkspaceRow(existing);
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const slug =
        attempt === 0
          ? input.primarySlug
          : `${input.primarySlug}-${Math.random().toString(36).slice(2, 8)}`;
      const [workspace] = await tx
        .insert(workspaces)
        .values({
          id: randomUUID(),
          organizationId: input.organizationId,
          name: input.name,
          slug,
          createdBy: input.userId,
        })
        .onConflictDoNothing({
          target: [workspaces.organizationId, workspaces.slug],
        })
        .returning();

      if (!workspace) {
        continue;
      }

      await tx
        .insert(workspaceMemberships)
        .values({
          workspaceId: workspace.id,
          userId: input.userId,
          role: "workspace_admin",
          source: "direct",
        })
        .onConflictDoUpdate({
          target: [
            workspaceMemberships.workspaceId,
            workspaceMemberships.userId,
          ],
          set: {
            role: "workspace_admin",
            source: "direct",
          },
        });

      return mapWorkspaceRow(workspace);
    }

    throw new Error("Failed to create user workspace");
  });
}

/**
 * The one workspace every member of a team organization shares. Unlike
 * `ensureUserWorkspaceInOrganizationRecord` this is keyed on the organization,
 * not on the user: the second member through the door joins the first
 * member's workspace instead of getting an empty one of their own.
 */
export async function ensureSharedWorkspaceRecord(input: {
  organizationId: string;
  name: string;
  primarySlug: string;
  createdBy: string;
}) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtext('sourceweft:shared-workspace'),
        hashtext(${input.organizationId})
      )
    `);

    const [existing] = await tx
      .select(workspaceColumns)
      .from(workspaces)
      .where(
        and(
          eq(workspaces.organizationId, input.organizationId),
          eq(workspaces.isDefault, true),
        ),
      )
      .orderBy(asc(workspaces.createdAt))
      .limit(1);

    if (existing) {
      return mapWorkspaceRow(existing);
    }

    // Deliberately does NOT adopt a pre-existing workspace. Organizations
    // created before shared workspaces existed hold their content in whoever's
    // private workspace it landed in; promoting one of those would hand a
    // newly invited teammate everything its owner had written in private, as a
    // side effect of accepting an invitation. New shared space, empty, and an
    // admin grants access to the older workspaces explicitly if they want to.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const slug =
        attempt === 0
          ? input.primarySlug
          : `${input.primarySlug}-${Math.random().toString(36).slice(2, 8)}`;
      const [workspace] = await tx
        .insert(workspaces)
        .values({
          id: randomUUID(),
          organizationId: input.organizationId,
          name: input.name,
          slug,
          isDefault: true,
          createdBy: input.createdBy,
        })
        .onConflictDoNothing({
          target: [workspaces.organizationId, workspaces.slug],
        })
        .returning();

      if (workspace) {
        return mapWorkspaceRow(workspace);
      }
    }

    throw new Error("Failed to create shared workspace");
  });
}

type WorkspaceAccessRow = {
  organization_id: string;
  is_default: boolean;
  organization_role: string | null;
  override_role: WorkspaceRole | null;
  membership_source: string | null;
};

/**
 * The single place where "what may this user do in this workspace" is decided.
 *
 * Two ways in, resolved in one query:
 *
 * - **Organization member** (`member` row present): the Model A path —
 *   role derives from the org role, an explicit `workspace_memberships` row can
 *   override it, and org owners/admins are container admins.
 * - **Guest** (a `workspace_memberships` row with `source = 'guest'` and no
 *   `member` row): an external collaborator invited to this one workspace.
 *   Content role only (capped at editor), never a container admin, no org
 *   standing.
 *
 * Returns null when neither holds — being able to name a workspace id is not
 * access.
 */
export async function resolveWorkspaceAccessRecord(input: {
  workspaceId: string;
  userId: string;
}): Promise<WorkspaceAccess | null> {
  const result = await db.execute<WorkspaceAccessRow>(sql`
    select
      w.organization_id,
      w.is_default,
      m.role as organization_role,
      wm.role as override_role,
      wm.source as membership_source
    from workspaces w
    left join member m
      on m."organizationId" = w.organization_id
     and m."userId" = ${input.userId}
    left join workspace_memberships wm
      on wm.workspace_id = w.id
     and wm.user_id = ${input.userId}
    where w.id = ${input.workspaceId}
    limit 1
  `);

  const row = result.rows?.[0];
  if (!row) {
    return null;
  }

  const isOrgMember = row.organization_role !== null;
  const isGuest = !isOrgMember && row.membership_source === "guest";

  if (!isOrgMember && !isGuest) {
    return null;
  }

  if (isGuest) {
    return {
      workspaceId: input.workspaceId,
      organizationId: row.organization_id,
      userId: input.userId,
      organizationRole: "",
      role: row.override_role ? capGuestRole(row.override_role) : null,
      source: "guest",
      isContainerAdmin: false,
    };
  }

  const organizationRole = row.organization_role as string;
  const { role, source } = resolveContentRole({
    organizationRole,
    isDefaultWorkspace: row.is_default,
    overrideRole: row.override_role,
  });

  return {
    workspaceId: input.workspaceId,
    organizationId: row.organization_id,
    userId: input.userId,
    organizationRole,
    role,
    source,
    isContainerAdmin: isOrganizationAdminRole(organizationRole),
  };
}

export async function findWorkspaceByIdForMember(input: {
  workspaceId: string;
  userId: string;
}) {
  const result = await db.execute<ListedWorkspaceRow>(sql`
    select
      w.id,
      w.organization_id,
      w.name,
      w.slug,
      w.is_default,
      w.created_by,
      w.created_at::text as created_at
    from workspaces w
    left join member m
      on m."organizationId" = w.organization_id
     and m."userId" = ${input.userId}
    left join workspace_memberships wm
      on wm.workspace_id = w.id
     and wm.user_id = ${input.userId}
    where w.id = ${input.workspaceId}
      and (
        (m."userId" is not null and (w.is_default or wm.user_id is not null))
        or wm.source = 'guest'
      )
    limit 1
  `);

  const row = result.rows?.[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    slug: row.slug,
    isDefault: row.is_default,
    createdBy: row.created_by,
    createdAt: row.created_at,
  } satisfies Workspace;
}

/**
 * Workspaces the user can enter as a *guest* — those in someone else's
 * organization they were invited into. Kept separate from
 * `listWorkspacesForMember`, which is scoped to one organization the user
 * belongs to; a guest's workspace lives in an organization they are not part of.
 */
export async function listGuestWorkspacesForUser(userId: string) {
  const result = await db.execute<ListedWorkspaceRow>(sql`
    select
      w.id,
      w.organization_id,
      w.name,
      w.slug,
      w.is_default,
      w.created_by,
      w.created_at::text as created_at
    from workspaces w
    join workspace_memberships wm
      on wm.workspace_id = w.id
     and wm.user_id = ${userId}
     and wm.source = 'guest'
    order by w.created_at asc
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    slug: row.slug,
    isDefault: row.is_default,
    createdBy: row.created_by,
    createdAt: row.created_at,
  })) satisfies Workspace[];
}

export async function findWorkspaceMembershipOverride(input: {
  workspaceId: string;
  userId: string;
}) {
  const [row] = await db
    .select()
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, input.workspaceId),
        eq(workspaceMemberships.userId, input.userId),
      ),
    )
    .limit(1);

  return row
    ? { workspaceId: row.workspaceId, userId: row.userId, role: row.role }
    : null;
}

type WorkspaceMemberRow = {
  user_id: string;
  organization_role: string;
  override_role: WorkspaceRole | null;
  name: string | null;
  email: string | null;
  image: string | null;
};

/**
 * Everyone who can currently enter the workspace, derived members included.
 *
 * Driven from `member` rather than from `workspace_memberships`, so a user who
 * left the organization disappears from the list immediately whether or not a
 * stale override row was cleaned up.
 */
export async function listWorkspaceMemberRecords(input: {
  workspaceId: string;
  organizationId: string;
  isDefaultWorkspace: boolean;
}): Promise<WorkspaceMember[]> {
  const result = await db.execute<WorkspaceMemberRow>(sql`
    select
      m."userId" as user_id,
      m.role as organization_role,
      wm.role as override_role,
      u.name,
      u.email,
      u.image
    from member m
    left join workspace_memberships wm
      on wm.workspace_id = ${input.workspaceId}
     and wm.user_id = m."userId"
    left join "user" u on u.id = m."userId"
    where m."organizationId" = ${input.organizationId}
      and (${input.isDefaultWorkspace} or wm.user_id is not null)
    order by m."createdAt" asc
  `);

  return (result.rows ?? []).flatMap((row) => {
    const { role, source } = resolveContentRole({
      organizationRole: row.organization_role,
      isDefaultWorkspace: input.isDefaultWorkspace,
      overrideRole: row.override_role,
    });

    if (!role || !source) {
      return [];
    }

    return [
      {
        workspaceId: input.workspaceId,
        userId: row.user_id,
        role,
        source,
        organizationRole: row.organization_role,
        name: row.name,
        email: row.email,
        image: row.image,
      },
    ];
  });
}

export type UserIdentityRecord = {
  userId: string;
  name: string | null;
  email: string | null;
  image: string | null;
};

/**
 * Resolve display identities for a set of users. Works for guests too: a guest
 * is a real `"user"` row (just not in this org's `member` table). Callers must
 * gate access before calling — this is a raw lookup with no authorization.
 */
export async function findUserIdentitiesByIds(
  userIds: string[],
): Promise<UserIdentityRecord[]> {
  if (userIds.length === 0) {
    return [];
  }
  const result = await db.execute<{
    id: string;
    name: string | null;
    email: string | null;
    image: string | null;
  }>(sql`
    select id, name, email, image
    from "user"
    where id = any(${userIds})
  `);
  return (result.rows ?? []).map((row) => ({
    userId: row.id,
    name: row.name,
    email: row.email,
    image: row.image,
  }));
}

/** Of the given users, which are members of `organizationId` (i.e. not guests). */
export async function filterOrganizationMemberIds(input: {
  organizationId: string;
  userIds: string[];
}): Promise<Set<string>> {
  if (input.userIds.length === 0) {
    return new Set();
  }
  const result = await db.execute<{ userId: string }>(sql`
    select m."userId" as "userId"
    from member m
    where m."organizationId" = ${input.organizationId}
      and m."userId" = any(${input.userIds})
  `);
  return new Set((result.rows ?? []).map((row) => row.userId));
}

export async function deleteWorkspaceMembershipRecord(input: {
  workspaceId: string;
  userId: string;
}) {
  const rows = await db
    .delete(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, input.workspaceId),
        eq(workspaceMemberships.userId, input.userId),
      ),
    )
    .returning();

  return rows.length > 0;
}

/**
 * Drops every override a user holds inside one organization, called when they
 * are removed from it.
 *
 * Purely hygiene: derived access already ends the moment the `member` row goes,
 * and better-auth's `/organization/leave` fires no hook at all, so nothing may
 * depend on this having run.
 */
export async function deleteOrganizationWorkspaceMemberships(input: {
  organizationId: string;
  userId: string;
}) {
  const result = await db.execute<{ workspace_id: string }>(sql`
    delete from workspace_memberships wm
    using workspaces w
    where w.id = wm.workspace_id
      and w.organization_id = ${input.organizationId}
      and wm.user_id = ${input.userId}
    returning wm.workspace_id
  `);

  return (result.rows ?? []).map((row) => row.workspace_id);
}

export async function findWorkspaceByIdInOrganization(input: {
  workspaceId: string;
  organizationId: string;
}) {
  const [row] = await db
    .select(workspaceColumns)
    .from(workspaces)
    .where(
      and(
        eq(workspaces.id, input.workspaceId),
        eq(workspaces.organizationId, input.organizationId),
      ),
    )
    .limit(1);

  return row ? mapWorkspaceRow(row) : null;
}

export async function findOrganizationMembership(input: {
  organizationId: string;
  userId: string;
}) {
  const result = await db.execute<OrganizationMembershipRow>(sql`
    select
      "organizationId" as organization_id,
      "userId" as user_id,
      role,
      "createdAt"::text as created_at
    from member
    where "organizationId" = ${input.organizationId} and "userId" = ${input.userId}
    limit 1
  `);

  const row = result.rows?.[0];
  if (!row) {
    return null;
  }

  return {
    organizationId: row.organization_id,
    userId: row.user_id,
    role: row.role,
    createdAt: row.created_at,
  };
}

export async function listOrganizationMemberships(organizationId: string) {
  const result = await db.execute<OrganizationMembershipRow>(sql`
    select
      "organizationId" as organization_id,
      "userId" as user_id,
      role,
      "createdAt"::text as created_at
    from member
    where "organizationId" = ${organizationId}
  `);

  return (result.rows ?? []).map((row) => ({
    organizationId: row.organization_id,
    userId: row.user_id,
    role: row.role,
    createdAt: row.created_at,
  }));
}

export async function findOrganizationById(organizationId: string) {
  const result = await db.execute<OrganizationRow>(sql`
    select
      id,
      name,
      slug,
      metadata,
      "createdAt"::text as created_at
    from organization
    where id = ${organizationId}
    limit 1
  `);

  const row = result.rows?.[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

export async function createPersonalOrganizationForUser(input: {
  name: string;
  slug: string;
  userId: string;
  metadata: Record<string, unknown>;
}) {
  const now = new Date();
  const organizationId = randomUUID();

  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtext('sourceweft:personal-organization'),
        hashtext(${input.userId})
      )
    `);

    const existingResult = await tx.execute<OrganizationMembershipRow>(sql`
      select
        m."organizationId" as organization_id,
        m."userId" as user_id,
        m.role,
        m."createdAt"::text as created_at
      from member m
      join organization o on o.id = m."organizationId"
      where m."userId" = ${input.userId}
        and o.metadata is not null
        and o.metadata <> ''
        and o.metadata::jsonb #>> '{sourceweft,kind}' = 'personal'
      limit 1
    `);

    const existing = existingResult.rows?.[0];
    if (existing) {
      return { created: false, id: existing.organization_id };
    }

    const organizationResult = await tx.execute<{ id: string }>(sql`
      insert into organization (
        id,
        name,
        slug,
        metadata,
        "createdAt"
      )
      values (
        ${organizationId},
        ${input.name},
        ${input.slug},
        ${JSON.stringify(input.metadata)},
        ${now}
      )
      returning id
    `);

    await tx.execute(sql`
      insert into member (
        id,
        "organizationId",
        "userId",
        role,
        "createdAt"
      )
      values (
        ${randomUUID()},
        ${organizationId},
        ${input.userId},
        'owner',
        ${now}
      )
    `);

    const row = organizationResult.rows?.[0];
    if (!row) {
      throw new Error("Failed to create personal organization");
    }

    return { created: true, id: row.id };
  });
}

export async function createTeamOrganizationForUser(input: {
  name: string;
  slug: string;
  userId: string;
  metadata: Record<string, unknown>;
  idempotencyKey: string;
}) {
  const now = new Date();
  const organizationId = randomUUID();

  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtext('sourceweft:team-organization'),
        hashtext(${input.idempotencyKey})
      )
    `);

    const existingResult = await tx.execute<{ id: string }>(sql`
      select id
      from organization
      where metadata is not null
        and metadata <> ''
        and metadata::jsonb #>> '{sourceweft,billingOrderId}' = ${input.idempotencyKey}
      limit 1
    `);

    const existing = existingResult.rows?.[0];
    if (existing) {
      return { created: false, id: existing.id };
    }

    const organizationResult = await tx.execute<{ id: string }>(sql`
      insert into organization (
        id,
        name,
        slug,
        metadata,
        "createdAt"
      )
      values (
        ${organizationId},
        ${input.name},
        ${input.slug},
        ${JSON.stringify(input.metadata)},
        ${now}
      )
      returning id
    `);

    await tx.execute(sql`
      insert into member (
        id,
        "organizationId",
        "userId",
        role,
        "createdAt"
      )
      values (
        ${randomUUID()},
        ${organizationId},
        ${input.userId},
        'owner',
        ${now}
      )
    `);

    const row = organizationResult.rows?.[0];
    if (!row) {
      throw new Error("Failed to create team organization");
    }

    return { created: true, id: row.id };
  });
}

export async function findPersonalOrganizationMembershipByUser(userId: string) {
  const result = await db.execute<OrganizationMembershipRow>(sql`
    select
      m."organizationId" as organization_id,
      m."userId" as user_id,
      m.role,
      m."createdAt"::text as created_at
    from member m
    join organization o on o.id = m."organizationId"
    where m."userId" = ${userId}
      and o.metadata is not null
      and o.metadata <> ''
      and o.metadata::jsonb #>> '{sourceweft,kind}' = 'personal'
    limit 1
  `);

  const row = result.rows?.[0];
  if (!row) {
    return null;
  }

  return {
    organizationId: row.organization_id,
    userId: row.user_id,
    role: row.role,
    createdAt: row.created_at,
  };
}

export async function isOrganizationMember(input: {
  organizationId: string;
  userId: string;
}) {
  const membership = await findOrganizationMembership(input);
  return Boolean(membership);
}
