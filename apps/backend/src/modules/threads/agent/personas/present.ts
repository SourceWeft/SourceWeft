import type { Persona } from "@sourceweft/contracts";
import { filesystemPolicyOf } from "./authoring";
import type { PersonaSpec } from "./types";

/** The wire shape of a persona, built-in or workspace-authored alike. */
export function presentPersona(persona: PersonaSpec): Persona {
  return {
    id: persona.slug,
    slug: persona.slug,
    name: persona.name,
    description: persona.description,
    systemPrompt: persona.systemPrompt,
    avatar: persona.avatar ?? null,
    trust: persona.trust,
    modelSettings:
      persona.modelSettings && Object.keys(persona.modelSettings).length > 0
        ? persona.modelSettings
        : null,
    toolAllowlist: persona.toolAllowlist ? [...persona.toolAllowlist] : null,
    filesystemPolicy: filesystemPolicyOf(persona),
    clonedFrom: persona.clonedFrom ?? null,
    createdBy: persona.createdBy ?? null,
    updatedAt: persona.updatedAt ?? null,
  };
}
