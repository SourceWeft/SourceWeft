import type { ChatSkillItem, ChatToolName } from "../../_components/chat-canvas";

function mergeSourceIds(...sourceIdGroups: (string[] | undefined)[]) {
  return [
    ...new Set(
      sourceIdGroups.flatMap((sourceIds) => sourceIds ?? []).filter(Boolean),
    ),
  ];
}

function removeDisabledToolSkills(input: {
  skillIds: string[];
  availableSkills: ChatSkillItem[];
  disabledToolNames: ChatToolName[];
}) {
  if (input.disabledToolNames.length === 0) {
    return input.skillIds;
  }
  const disabledToolNameSet = new Set(input.disabledToolNames);
  return input.skillIds.filter((skillId) => {
    const skill = input.availableSkills.find((item) => item.id === skillId);
    return !skill?.tools?.some((toolName) =>
      disabledToolNameSet.has(toolName as ChatToolName),
    );
  });
}

function resolveClientTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export { mergeSourceIds, removeDisabledToolSkills, resolveClientTimezone };
