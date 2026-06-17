import type { ChatSkillItem, ChatToolName } from "../../_components/chat-canvas";
import type { ChatMessageItem } from "../streaming-assistant-state";

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

function resolveAttachOnlyAssistantMessage(input: {
  assistantMessageId?: string | null;
  messages: ChatMessageItem[];
}) {
  const latestAssistantMessage =
    [...input.messages]
      .reverse()
      .find((message) => message.role === "assistant") ??
    null;
  if (!input.assistantMessageId) {
    return latestAssistantMessage;
  }

  return (
    input.messages.find(
      (message) =>
        message.role === "assistant" && message.id === input.assistantMessageId,
    ) ??
    latestAssistantMessage
  );
}

function getThreadBootstrapKey(
  workspaceId: string | null | undefined,
  threadId: string,
) {
  return workspaceId ? `${workspaceId}:${threadId}` : null;
}

function shouldResetThreadLocalState(input: {
  bootstrappedThreadKey: string | null;
  threadId: string;
  workspaceId: string | null | undefined;
}) {
  const bootstrapKey = getThreadBootstrapKey(input.workspaceId, input.threadId);
  return !bootstrapKey || input.bootstrappedThreadKey !== bootstrapKey;
}

export {
  getThreadBootstrapKey,
  mergeSourceIds,
  removeDisabledToolSkills,
  resolveAttachOnlyAssistantMessage,
  resolveClientTimezone,
  shouldResetThreadLocalState,
};
