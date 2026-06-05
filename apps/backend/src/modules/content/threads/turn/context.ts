import { ContentError } from "../../errors";
import { requireContentWorkspace } from "../../content-support";
import type { MessageRecord } from "../../types";
import type { AgentCheckpointMetadata, AgentCheckpointRef } from "./types";
import { findThreadRecord } from "../thread/repository";
import { listMessageRecordsByThread } from "../message-repository";
import {
  resolveGenerateImageToolFromToolsMetadata,
  resolveGeneratePptxToolFromToolsMetadata,
  resolveGenerateVideoPresentationToolFromToolsMetadata,
  resolveMcpToolSelectionFromToolsMetadata,
  resolveNotionToolSelectionsFromToolsMetadata,
  resolveWebSearchEnabledFromToolsMetadata,
} from "./tool-selection";

export function collapseSupersededMessages(items: MessageRecord[]) {
  const supersededIds = new Set(
    items
      .map((item) => item.parentMessageId)
      .filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      ),
  );

  return items.filter((item) => !supersededIds.has(item.id));
}

function resolveMessageRootId(input: {
  messageById: Map<string, MessageRecord>;
  messageId: string;
}) {
  let current = input.messageById.get(input.messageId);
  const seen = new Set<string>();
  while (current?.parentMessageId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = input.messageById.get(current.parentMessageId);
    if (!parent) {
      break;
    }
    current = parent;
  }

  return current?.id ?? input.messageId;
}

export function filterMessagesBeforeEditAnchor(input: {
  anchorUserMessageId?: string | null;
  messages: MessageRecord[];
}) {
  if (!input.anchorUserMessageId) {
    return input.messages;
  }

  const messageById = new Map(
    input.messages.map((message) => [message.id, message]),
  );
  const anchorMessage = messageById.get(input.anchorUserMessageId);
  if (!anchorMessage) {
    return input.messages;
  }

  const anchorRootId = resolveMessageRootId({
    messageById,
    messageId: anchorMessage.id,
  });
  const anchorRootIndex = input.messages.findIndex(
    (message) => message.id === anchorRootId,
  );
  if (anchorRootIndex < 0) {
    return input.messages;
  }

  return input.messages.slice(0, anchorRootIndex);
}

export function isContextExcludedMessage(
  message: MessageRecord | null | undefined,
) {
  if (!message?.metadata || typeof message.metadata !== "object") {
    return false;
  }

  const metadata = message.metadata as Record<string, unknown>;
  return metadata.excludeFromContext === true || metadata.isError === true;
}

export function resolveSourceIdsFromMessage(
  message: MessageRecord | null | undefined,
): string[] {
  const metadata =
    message?.metadata && typeof message.metadata === "object"
      ? (message.metadata as {
          sourceIds?: unknown;
        })
      : undefined;
  const sourceIds = metadata?.sourceIds;

  if (!Array.isArray(sourceIds)) {
    return [];
  }

  return sourceIds.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

export function resolveMentionedSourceIdsFromMessage(
  message: MessageRecord | null | undefined,
): string[] {
  const metadata =
    message?.metadata && typeof message.metadata === "object"
      ? (message.metadata as {
          mentionedSourceIds?: unknown;
        })
      : undefined;
  const mentionedSourceIds = metadata?.mentionedSourceIds;

  if (!Array.isArray(mentionedSourceIds)) {
    return [];
  }

  return mentionedSourceIds.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

export function resolveSkillIdsFromMessage(
  message: MessageRecord | null | undefined,
): string[] {
  const metadata =
    message?.metadata && typeof message.metadata === "object"
      ? (message.metadata as {
          skillIds?: unknown;
          tools?: unknown;
        })
      : undefined;
  const tools =
    metadata?.tools &&
    typeof metadata.tools === "object" &&
    !Array.isArray(metadata.tools)
      ? (metadata.tools as { skillIds?: unknown })
      : undefined;
  const skillIds = Array.isArray(tools?.skillIds)
    ? tools.skillIds
    : metadata?.skillIds;

  if (!Array.isArray(skillIds)) {
    return [];
  }

  return skillIds.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

export function resolveWebSearchEnabledFromMessage(
  message: MessageRecord | null | undefined,
) {
  const metadata =
    message?.metadata && typeof message.metadata === "object"
      ? (message.metadata as {
          tools?: unknown;
        })
      : undefined;
  return resolveWebSearchEnabledFromToolsMetadata(metadata?.tools);
}

export function resolveGenerateImageToolFromMessage(
  message: MessageRecord | null | undefined,
) {
  const metadata =
    message?.metadata && typeof message.metadata === "object"
      ? (message.metadata as {
          tools?: unknown;
        })
      : undefined;
  return resolveGenerateImageToolFromToolsMetadata(metadata?.tools);
}

export function resolveGeneratePptxToolFromMessage(
  message: MessageRecord | null | undefined,
) {
  const metadata =
    message?.metadata && typeof message.metadata === "object"
      ? (message.metadata as {
          tools?: unknown;
        })
      : undefined;
  return resolveGeneratePptxToolFromToolsMetadata(metadata?.tools);
}

export function resolveGenerateVideoPresentationToolFromMessage(
  message: MessageRecord | null | undefined,
) {
  const metadata =
    message?.metadata && typeof message.metadata === "object"
      ? (message.metadata as {
          tools?: unknown;
        })
      : undefined;
  return resolveGenerateVideoPresentationToolFromToolsMetadata(metadata?.tools);
}

export function resolveNotionToolSelectionsFromMessage(
  message: MessageRecord | null | undefined,
) {
  const metadata =
    message?.metadata && typeof message.metadata === "object"
      ? (message.metadata as {
          tools?: unknown;
        })
      : undefined;
  return resolveNotionToolSelectionsFromToolsMetadata(metadata?.tools);
}

export function resolveMcpToolSelectionFromMessage(
  message: MessageRecord | null | undefined,
) {
  const metadata =
    message?.metadata && typeof message.metadata === "object"
      ? (message.metadata as {
          tools?: unknown;
        })
      : undefined;
  return resolveMcpToolSelectionFromToolsMetadata(metadata?.tools);
}

function toObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function normalizeAgentCheckpointRef(
  value: unknown,
): AgentCheckpointRef | null {
  const record = toObjectRecord(value);
  if (!record) {
    return null;
  }

  const threadId = typeof record.threadId === "string" ? record.threadId : null;
  const checkpointId =
    typeof record.checkpointId === "string" ? record.checkpointId : null;
  if (!threadId || !checkpointId) {
    return null;
  }

  const checkpointNs =
    typeof record.checkpointNs === "string" ? record.checkpointNs : undefined;

  return checkpointNs === undefined
    ? { threadId, checkpointId }
    : { threadId, checkpointId, checkpointNs };
}

export function resolveAgentCheckpointMetadata(
  message: MessageRecord | null | undefined,
): AgentCheckpointMetadata | null {
  const metadata = toObjectRecord(message?.metadata);
  const checkpoint = toObjectRecord(metadata?.agentCheckpoint);
  if (!checkpoint) {
    return null;
  }

  return {
    beforeInput: normalizeAgentCheckpointRef(checkpoint.beforeInput),
    beforeAssistant: normalizeAgentCheckpointRef(
      checkpoint.beforeAssistant ?? checkpoint.parent,
    ),
    resume: normalizeAgentCheckpointRef(checkpoint.resume),
    final: normalizeAgentCheckpointRef(checkpoint.final),
  };
}

function resolveLatestThreadTurn(messages: MessageRecord[]) {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }

  if (latestUserIndex < 0) {
    return {
      latestUserMessage: null,
      latestAssistantMessage: null,
    };
  }

  const latestUserMessage = messages[latestUserIndex] ?? null;
  const assistantMessages = messages
    .slice(latestUserIndex + 1)
    .filter((message) => message.role === "assistant");

  return {
    latestUserMessage,
    latestAssistantMessage:
      assistantMessages.length > 0
        ? (assistantMessages[assistantMessages.length - 1] ?? null)
        : null,
  };
}

function resolveAssistantForUserMessage(
  messages: MessageRecord[],
  userMessage: MessageRecord,
) {
  const assistantsFromMetadata = messages.filter((message) => {
    if (message.role !== "assistant") {
      return false;
    }

    if (!message.metadata || typeof message.metadata !== "object") {
      return false;
    }

    const metadataUserMessageId = (
      message.metadata as { userMessageId?: unknown }
    ).userMessageId;
    return metadataUserMessageId === userMessage.id;
  });
  if (assistantsFromMetadata.length > 0) {
    return assistantsFromMetadata[assistantsFromMetadata.length - 1] ?? null;
  }

  const userIndex = messages.findIndex(
    (message) => message.id === userMessage.id,
  );
  if (userIndex < 0) {
    return null;
  }

  const nextUserIndex = messages.findIndex(
    (message, index) => index > userIndex && message.role === "user",
  );
  const candidates = messages
    .slice(userIndex + 1, nextUserIndex >= 0 ? nextUserIndex : undefined)
    .filter((message) => message.role === "assistant");

  return candidates[candidates.length - 1] ?? null;
}

function resolveUserForAssistantMessage(
  messages: MessageRecord[],
  assistantMessage: MessageRecord,
) {
  if (
    assistantMessage.metadata &&
    typeof assistantMessage.metadata === "object"
  ) {
    const metadataUserMessageId = (
      assistantMessage.metadata as { userMessageId?: unknown }
    ).userMessageId;
    if (
      typeof metadataUserMessageId === "string" &&
      metadataUserMessageId.length > 0
    ) {
      const userFromMetadata = messages.find(
        (message) =>
          message.id === metadataUserMessageId && message.role === "user",
      );
      if (userFromMetadata) {
        return userFromMetadata;
      }
    }
  }

  const assistantIndex = messages.findIndex(
    (message) => message.id === assistantMessage.id,
  );
  if (assistantIndex < 0) {
    return null;
  }

  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate?.role === "user") {
      return candidate;
    }
  }

  return null;
}

function ensureMessageIsInThread(
  message: MessageRecord | undefined,
  threadId: string,
  code: string,
) {
  if (!message) {
    return;
  }

  if (message.threadId !== threadId) {
    throw new ContentError(400, code, "Message does not belong to the thread");
  }
}

export async function resolveThreadTurnContext(input: {
  workspaceId: string;
  threadId: string;
  userId: string;
  userMessageId?: string;
  assistantMessageId?: string;
}) {
  const workspace = await requireContentWorkspace({
    workspaceId: input.workspaceId,
    userId: input.userId,
  });

  const thread = await findThreadRecord({
    threadId: input.threadId,
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
  });

  if (!thread) {
    throw new ContentError(404, "THREAD_NOT_FOUND", "Thread not found");
  }

  const allMessages = await listMessageRecordsByThread({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    threadId: thread.id,
  });

  if (!input.userMessageId && !input.assistantMessageId) {
    const messages = collapseSupersededMessages(allMessages).filter(
      (message) => !isContextExcludedMessage(message),
    );
    const { latestUserMessage, latestAssistantMessage } =
      resolveLatestThreadTurn(messages);

    return {
      workspace,
      thread,
      latestUserMessage,
      latestAssistantMessage,
    };
  }

  const messageById = new Map(
    allMessages.map((message) => [message.id, message]),
  );
  const requestedUserMessage = input.userMessageId
    ? messageById.get(input.userMessageId)
    : undefined;
  const requestedAssistantMessage = input.assistantMessageId
    ? messageById.get(input.assistantMessageId)
    : undefined;

  if (input.userMessageId && !requestedUserMessage) {
    throw new ContentError(404, "MESSAGE_NOT_FOUND", "User message not found");
  }
  if (input.assistantMessageId && !requestedAssistantMessage) {
    throw new ContentError(
      404,
      "MESSAGE_NOT_FOUND",
      "Assistant message not found",
    );
  }

  ensureMessageIsInThread(
    requestedUserMessage,
    thread.id,
    "INVALID_USER_MESSAGE",
  );
  ensureMessageIsInThread(
    requestedAssistantMessage,
    thread.id,
    "INVALID_ASSISTANT_MESSAGE",
  );

  if (requestedUserMessage && requestedUserMessage.role !== "user") {
    throw new ContentError(
      400,
      "INVALID_USER_MESSAGE",
      "Message is not a user message",
    );
  }
  if (
    requestedAssistantMessage &&
    requestedAssistantMessage.role !== "assistant"
  ) {
    throw new ContentError(
      400,
      "INVALID_ASSISTANT_MESSAGE",
      "Message is not an assistant message",
    );
  }

  const userMessage = requestedUserMessage
    ? requestedUserMessage
    : requestedAssistantMessage
      ? resolveUserForAssistantMessage(allMessages, requestedAssistantMessage)
      : null;
  const assistantMessage = requestedAssistantMessage
    ? requestedAssistantMessage
    : requestedUserMessage
      ? resolveAssistantForUserMessage(allMessages, requestedUserMessage)
      : null;

  return {
    userId: input.userId,
    workspace,
    thread,
    latestUserMessage: userMessage,
    latestAssistantMessage: assistantMessage,
  };
}
