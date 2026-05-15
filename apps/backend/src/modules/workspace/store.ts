import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../../shared/database";
import { workspaceMemberships, workspaces } from "../../shared/db/schema";
import type { Workspace, WorkspaceMembership, WorkspaceRole } from "./types";

type WorkspaceRow = Pick<
  typeof workspaces.$inferSelect,
  "id" | "organizationId" | "name" | "slug" | "createdBy" | "createdAt"
>;
type WorkspaceMembershipRow = typeof workspaceMemberships.$inferSelect;

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
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapMembershipRow(row: WorkspaceMembershipRow): WorkspaceMembership {
  return {
    workspaceId: row.workspaceId,
    userId: row.userId,
    role: row.role,
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

export async function ensureWorkspaceMembership(input: {
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
    })
    .onConflictDoUpdate({
      target: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
      set: {
        role: input.role,
      },
    })
    .returning();

  if (!row) {
    throw new Error("Failed to ensure workspace membership");
  }

  return mapMembershipRow(row);
}

export async function listWorkspacesForMember(input: {
  organizationId: string;
  userId: string;
}) {
  const rows = await db
    .select({
      id: workspaces.id,
      organizationId: workspaces.organizationId,
      name: workspaces.name,
      slug: workspaces.slug,
      createdBy: workspaces.createdBy,
      createdAt: workspaces.createdAt,
    })
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
    .orderBy(asc(workspaces.createdAt));

  return rows.map(mapWorkspaceRow);
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
      .select({
        id: workspaces.id,
        organizationId: workspaces.organizationId,
        name: workspaces.name,
        slug: workspaces.slug,
        createdBy: workspaces.createdBy,
        createdAt: workspaces.createdAt,
      })
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

export async function findWorkspaceByIdForMember(input: {
  workspaceId: string;
  userId: string;
}) {
  const [row] = await db
    .select({
      id: workspaces.id,
      organizationId: workspaces.organizationId,
      name: workspaces.name,
      slug: workspaces.slug,
      createdBy: workspaces.createdBy,
      createdAt: workspaces.createdAt,
    })
    .from(workspaces)
    .innerJoin(
      workspaceMemberships,
      eq(workspaceMemberships.workspaceId, workspaces.id),
    )
    .where(
      and(
        eq(workspaces.id, input.workspaceId),
        eq(workspaceMemberships.userId, input.userId),
      ),
    )
    .limit(1);

  return row ? mapWorkspaceRow(row) : null;
}

export async function findWorkspaceMembership(input: {
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

  return row ? mapMembershipRow(row) : null;
}

export async function findWorkspaceByIdInOrganization(input: {
  workspaceId: string;
  organizationId: string;
}) {
  const [row] = await db
    .select({
      id: workspaces.id,
      organizationId: workspaces.organizationId,
      name: workspaces.name,
      slug: workspaces.slug,
      createdBy: workspaces.createdBy,
      createdAt: workspaces.createdAt,
    })
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

export async function findFirstWorkspaceByOrganization(input: {
  organizationId: string;
}) {
  const [row] = await db
    .select({
      id: workspaces.id,
      organizationId: workspaces.organizationId,
      name: workspaces.name,
      slug: workspaces.slug,
      createdBy: workspaces.createdBy,
      createdAt: workspaces.createdAt,
    })
    .from(workspaces)
    .where(eq(workspaces.organizationId, input.organizationId))
    .orderBy(asc(workspaces.createdAt))
    .limit(1);

  return row ? mapWorkspaceRow(row) : null;
}

export async function findMembershipByUser(userId: string) {
  const [row] = await db
    .select()
    .from(workspaceMemberships)
    .where(eq(workspaceMemberships.userId, userId))
    .limit(1);
  return row ? mapMembershipRow(row) : null;
}
