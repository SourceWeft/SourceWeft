import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { agentPersonas, db } from "@sourceweft/db";
import { READ_ONLY_FILESYSTEM_PERMISSIONS } from "../subagents/read-only";
import {
  derivePersonaSlug,
  uniquePersonaSlug,
  type PersonaDraft,
} from "./authoring";
import type { PersonaSpec } from "./types";

type AgentPersonaRow = typeof agentPersonas.$inferSelect;

export function isWorkspacePersonaId(value: string) {
  return value.startsWith("persona_");
}

/** A workspace row as the same shape the turn consumes for a built-in. */
export function mapAgentPersonaRow(row: AgentPersonaRow): PersonaSpec {
  const modelSettings = row.modelSettingsJson ?? {};
  return {
    slug: row.id,
    name: row.name,
    description: row.description,
    systemPrompt: row.systemPrompt,
    ...(Object.keys(modelSettings).length > 0 ? { modelSettings } : {}),
    ...(row.toolAllowlistJson ? { toolAllowlist: row.toolAllowlistJson } : {}),
    ...(row.filesystemPolicy === "read_only"
      ? { filesystemPermissions: READ_ONLY_FILESYSTEM_PERMISSIONS }
      : {}),
    ...(row.avatar ? { avatar: row.avatar } : {}),
    trust: "user",
    clonedFrom: row.clonedFrom,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listAgentPersonaRows(input: {
  teamId: string;
  workspaceId: string;
}) {
  return db
    .select()
    .from(agentPersonas)
    .where(
      and(
        eq(agentPersonas.teamId, input.teamId),
        eq(agentPersonas.workspaceId, input.workspaceId),
      ),
    )
    .orderBy(asc(agentPersonas.createdAt), asc(agentPersonas.id));
}

export async function findAgentPersonaRow(input: {
  teamId: string;
  workspaceId: string;
  personaId: string;
}) {
  const rows = await db
    .select()
    .from(agentPersonas)
    .where(
      and(
        eq(agentPersonas.id, input.personaId),
        eq(agentPersonas.teamId, input.teamId),
        eq(agentPersonas.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function insertAgentPersonaRow(input: {
  teamId: string;
  workspaceId: string;
  createdBy: string;
  clonedFrom: string;
  draft: PersonaDraft;
}) {
  const taken = (
    await db
      .select({ slug: agentPersonas.slug })
      .from(agentPersonas)
      .where(eq(agentPersonas.workspaceId, input.workspaceId))
  ).map((row) => row.slug);
  const rows = await db
    .insert(agentPersonas)
    .values({
      id: `persona_${randomUUID()}`,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      slug: uniquePersonaSlug(derivePersonaSlug(input.draft.name), taken),
      name: input.draft.name,
      description: input.draft.description,
      systemPrompt: input.draft.systemPrompt,
      avatar: input.draft.avatar,
      modelSettingsJson: input.draft.modelSettings,
      toolAllowlistJson: input.draft.toolAllowlist,
      filesystemPolicy: input.draft.filesystemPolicy,
      clonedFrom: input.clonedFrom,
      createdBy: input.createdBy,
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error("Failed to create persona");
  }
  return row;
}

export async function updateAgentPersonaRow(input: {
  teamId: string;
  workspaceId: string;
  personaId: string;
  patch: Partial<PersonaDraft>;
}) {
  const { patch } = input;
  const rows = await db
    .update(agentPersonas)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description }
        : {}),
      ...(patch.systemPrompt !== undefined
        ? { systemPrompt: patch.systemPrompt }
        : {}),
      ...(patch.modelSettings !== undefined
        ? { modelSettingsJson: patch.modelSettings }
        : {}),
      ...(patch.toolAllowlist !== undefined
        ? { toolAllowlistJson: patch.toolAllowlist }
        : {}),
      ...(patch.filesystemPolicy !== undefined
        ? { filesystemPolicy: patch.filesystemPolicy }
        : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentPersonas.id, input.personaId),
        eq(agentPersonas.teamId, input.teamId),
        eq(agentPersonas.workspaceId, input.workspaceId),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function deleteAgentPersonaRow(input: {
  teamId: string;
  workspaceId: string;
  personaId: string;
}) {
  const rows = await db
    .delete(agentPersonas)
    .where(
      and(
        eq(agentPersonas.id, input.personaId),
        eq(agentPersonas.teamId, input.teamId),
        eq(agentPersonas.workspaceId, input.workspaceId),
      ),
    )
    .returning({ id: agentPersonas.id });
  return rows.length > 0;
}
