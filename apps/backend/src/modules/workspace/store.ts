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
