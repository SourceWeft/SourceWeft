import type { EnabledSkillDescriptor } from "../../skills/types";

export function normalizeInvokedSkillIds(input: {
  enabledSkills: readonly EnabledSkillDescriptor[];
  requestedSkillIds: unknown;
}): string[] {
  if (!Array.isArray(input.requestedSkillIds)) {
    return [];
  }
  const enabledSkillIds = new Set(
    input.enabledSkills.map((skill) => skill.workspaceSkillId),
  );
  return Array.from(
    new Set(
      input.requestedSkillIds.filter(
        (value): value is string =>
          typeof value === "string" && enabledSkillIds.has(value),
      ),
    ),
  );
}

export function resolveActiveSkillPromptIds(input: {
  enabledSkills: readonly EnabledSkillDescriptor[];
  invokedSkillIds: unknown;
  selectedSkillIds: unknown;
}): string[] {
  const invokedSkillIds = normalizeInvokedSkillIds({
    enabledSkills: input.enabledSkills,
    requestedSkillIds: input.invokedSkillIds,
  });
  const enabledSkillsById = new Map(
    input.enabledSkills.map((skill) => [skill.workspaceSkillId, skill]),
  );
  const selectedNonDefaultSkillIds = normalizeInvokedSkillIds({
    enabledSkills: input.enabledSkills,
    requestedSkillIds: input.selectedSkillIds,
  }).filter(
    (skillId) => enabledSkillsById.get(skillId)?.defaultEnabled !== true,
  );

  // Default skills stay available without forcing their workflow instructions
  // into every turn. An explicit invocation remains authoritative either way.
  return Array.from(
    new Set([...selectedNonDefaultSkillIds, ...invokedSkillIds]),
  );
}
