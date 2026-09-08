import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import type { ToolPermission } from "../../turn/command-registry";
import { ContentError } from "../../../content/errors";
import {
  buildPersonaDraft,
  buildPersonaPatch,
  PERSONA_AVAILABLE_TOOLS,
  type PersonaOverrides,
} from "./authoring";
import { BUILTIN_PERSONAS } from "./builtin";
import {
  deleteAgentPersonaRow,
  findAgentPersonaRow,
  insertAgentPersonaRow,
  isWorkspacePersonaId,
  listAgentPersonaRows,
  mapAgentPersonaRow,
  updateAgentPersonaRow,
} from "./repository";
import type { PersonaSpec } from "./types";

type WorkspaceScope = {
  teamId: string;
  workspaceId: string;
};

/**
 * The built-in roster. Synchronous and code-only on purpose: callers that
 * only need the shipped personas (and tests) never touch the database.
 */
export function listPersonas(): PersonaSpec[] {
  return [...BUILTIN_PERSONAS];
}

/** A built-in persona by slug; null for anything else, including row ids. */
export function findPersona(
  slug: string | null | undefined,
): PersonaSpec | null {
  if (!slug) {
    return null;
  }
  const normalized = slug.trim();
  return (
    BUILTIN_PERSONAS.find((persona) => persona.slug === normalized) ?? null
  );
}

/**
 * Whatever `threads.persona_id` names: a built-in by slug, or a workspace
 * persona by row id. Scoped to the workspace so a row from another workspace
 * can never drive a thread here.
 */
export async function resolvePersona(
  input: WorkspaceScope & { personaId: string | null | undefined },
): Promise<PersonaSpec | null> {
  if (!input.personaId) {
    return null;
  }
  const builtin = findPersona(input.personaId);
  if (builtin) {
    return builtin;
  }
  const personaId = input.personaId.trim();
  if (!isWorkspacePersonaId(personaId)) {
    return null;
  }
  const row = await findAgentPersonaRow({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    personaId,
  });
  return row ? mapAgentPersonaRow(row) : null;
}

/** Built-ins first, then the workspace's own personas in creation order. */
export async function listWorkspacePersonas(
  input: WorkspaceScope,
): Promise<PersonaSpec[]> {
  const rows = await listAgentPersonaRows(input);
  return [...BUILTIN_PERSONAS, ...rows.map(mapAgentPersonaRow)];
}

/**
 * Author a workspace persona by cloning `sourceId` (a built-in slug or a
 * workspace persona id) and applying `overrides` to the copy. Cloning is the
 * only creation path, so a new persona is exactly as valid as its source.
 */
export async function createWorkspacePersona(
  input: WorkspaceScope & {
    userId: string;
    sourceId: string;
    overrides?: PersonaOverrides;
  },
): Promise<PersonaSpec> {
  const source = await resolvePersona({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    personaId: input.sourceId,
  });
  if (!source) {
    throw new ContentError(404, "PERSONA_NOT_FOUND", "Persona not found");
  }
  const draft = buildPersonaDraft({
    source,
    overrides: input.overrides,
    availableTools: PERSONA_AVAILABLE_TOOLS,
  });
  const row = await insertAgentPersonaRow({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    createdBy: input.userId,
    clonedFrom: source.slug,
    draft,
  });
  return mapAgentPersonaRow(row);
}

/** Apply a validated partial edit; null when no such workspace persona. */
export async function updateWorkspacePersona(
  input: WorkspaceScope & { personaId: string; patch: PersonaOverrides },
): Promise<PersonaSpec | null> {
  const patch = buildPersonaPatch({
    patch: input.patch,
    availableTools: PERSONA_AVAILABLE_TOOLS,
  });
  const row = await updateAgentPersonaRow({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    personaId: input.personaId,
    patch,
  });
  return row ? mapAgentPersonaRow(row) : null;
}

/** Remove a workspace persona; false when no such row. Built-ins have no row. */
export async function deleteWorkspacePersona(
  input: WorkspaceScope & { personaId: string },
): Promise<boolean> {
  return deleteAgentPersonaRow(input);
}

/**
 * Narrow a turn's tool permissions to a persona's allowlist. Every known
 * business tool not on the list is denied so the existing permission seam
 * (`filterAllowedTools`, the interpreter's allowed set) enforces the persona
 * without learning about personas. A persona without an allowlist inherits the
 * permissions untouched.
 */
export function applyPersonaToolAllowlist(
  permissions: Record<string, ToolPermission>,
  persona: PersonaSpec | null | undefined,
): Record<string, ToolPermission> {
  if (!persona?.toolAllowlist) {
    return permissions;
  }
  const allowed = new Set(persona.toolAllowlist);
  const narrowed: Record<string, ToolPermission> = { ...permissions };
  const knownToolNames = new Set<string>([
    ...Object.values(AGENT_TOOL_NAMES),
    ...Object.keys(permissions),
  ]);
  for (const toolName of knownToolNames) {
    if (!allowed.has(toolName)) {
      narrowed[toolName] = "deny";
    }
  }
  return narrowed;
}

/**
 * Drop bound tools a persona may not use. Complements
 * {@link applyPersonaToolAllowlist}: permissions only cover tools the registry
 * knows by name, while connector, MCP, and sandbox tools are bound by their own
 * names and would otherwise slip past an allowlist.
 */
export function filterToolsForPersona<T extends { name: string }>(
  persona: PersonaSpec | null | undefined,
  tools: readonly T[],
): T[] {
  if (!persona?.toolAllowlist) {
    return [...tools];
  }
  const allowed = new Set(persona.toolAllowlist);
  return tools.filter((tool) => allowed.has(tool.name));
}
