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
