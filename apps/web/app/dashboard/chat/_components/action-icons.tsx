import {
  getAgentToolDefinition,
  getAgentToolSlashCommand,
} from "@sourceweft/agent-tool-registry";
import type {
  PromptInputCommandIconName,
  PromptInputCommandIconTone,
} from "@sourceweft/ui-web/components/ai-elements/prompt-input";

export type ActionIconSpec = {
  iconName: PromptInputCommandIconName;
  iconTone?: PromptInputCommandIconTone;
};
export type SerializableActionIconPayload = {
  iconName?: PromptInputCommandIconName;
  iconTone?: PromptInputCommandIconTone;
};
export type PromptInputActionIconPayload = SerializableActionIconPayload;

function normalizeActionName(value: string | null | undefined) {
  return value?.trim().replace(/^\//, "").toLowerCase() ?? "";
}

export function getActionIcon(
  actionName: string | null | undefined,
): ActionIconSpec | null {
  const normalized = normalizeActionName(actionName);
  if (!normalized) return null;

  const slash = getAgentToolSlashCommand(normalized);
  if (slash?.iconName) {
    return {
      iconName: slash.iconName,
      ...(slash.iconTone ? { iconTone: slash.iconTone } : {}),
    };
  }

  return getAgentToolDefinition(normalized) ? { iconName: "tool" } : null;
}

export function getSerializableActionIcon(
  actionName: string | null | undefined,
): SerializableActionIconPayload {
  return getActionIcon(actionName) ?? {};
}

export function getPromptInputActionIcon(
  actionName: string | null | undefined,
): PromptInputActionIconPayload {
  return getSerializableActionIcon(actionName);
}
