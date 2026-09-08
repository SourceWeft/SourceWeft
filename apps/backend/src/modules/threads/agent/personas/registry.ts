import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import type { ToolPermission } from "../../turn/command-registry";
import { BUILTIN_PERSONAS } from "./builtin";
import type { PersonaSpec } from "./types";

/**
 * Every persona a workspace may start a thread with. Built-ins only for now;
 * workspace-authored personas join this union when their table lands, which is
 * why callers receive a fresh array rather than the frozen roster itself.
 */
export function listPersonas(): PersonaSpec[] {
  return [...BUILTIN_PERSONAS];
}

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
