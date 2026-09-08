import type {
  CreatePersonaRequest,
  Persona,
  UpdatePersonaRequest,
} from "@sourceweft/contracts";

/** Built-ins first, then the workspace's own personas, each in API order. */
export function groupPersonas(items: readonly Persona[]) {
  return {
    builtIn: items.filter((persona) => persona.trust === "system"),
    custom: items.filter((persona) => persona.trust !== "system"),
  };
}

/** What the editor holds for one persona; strings so inputs stay controlled. */
export type PersonaDraftForm = {
  name: string;
  description: string;
  systemPrompt: string;
  /** Empty = the workspace default model. */
  llmProfileAlias: string;
  /** Null = every tool the workspace offers. */
  toolAllowlist: string[] | null;
  readOnly: boolean;
};

export function draftFromPersona(persona: Persona): PersonaDraftForm {
  return {
    name: persona.name,
    description: persona.description,
    systemPrompt: persona.systemPrompt,
    llmProfileAlias: persona.modelSettings?.llmProfileAlias ?? "",
    toolAllowlist: persona.toolAllowlist ? [...persona.toolAllowlist] : null,
    readOnly: persona.filesystemPolicy === "read_only",
  };
}

/** The editable fields of a draft as the API expects them. */
export function payloadFromDraft(
  draft: PersonaDraftForm,
): UpdatePersonaRequest {
  const llmProfileAlias = draft.llmProfileAlias.trim();
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    systemPrompt: draft.systemPrompt.trim(),
    modelSettings: llmProfileAlias ? { llmProfileAlias } : null,
    toolAllowlist: draft.toolAllowlist,
    filesystemPolicy: draft.readOnly ? "read_only" : "default",
  };
}

export function createPayloadFromDraft(
  sourceId: string,
  draft: PersonaDraftForm,
): CreatePersonaRequest {
  return { sourceId, ...payloadFromDraft(draft) };
}

/**
 * Toggle one tool in an allowlist. Leaving "all tools" (null) for a specific
 * pick starts from every available tool minus the one unticked, so the first
 * click never silently strips the persona down to a single tool.
 */
export function toggleAllowlistTool(
  allowlist: string[] | null,
  tool: string,
  availableTools: readonly string[],
): string[] {
  const current = allowlist ?? [...availableTools];
  return current.includes(tool)
    ? current.filter((entry) => entry !== tool)
    : [...current, tool];
}

/** A short "from X" label for a workspace persona's source, if still listed. */
export function describePersonaSource(
  persona: Persona,
  all: readonly Persona[],
) {
  if (!persona.clonedFrom) {
    return null;
  }
  const source = all.find((candidate) => candidate.id === persona.clonedFrom);
  return source?.name ?? persona.clonedFrom;
}

/** A draft has everything the API requires. */
export function isDraftComplete(draft: PersonaDraftForm) {
  return draft.name.trim().length > 0 && draft.systemPrompt.trim().length > 0;
}
