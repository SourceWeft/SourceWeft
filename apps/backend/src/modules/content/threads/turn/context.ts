import { ContentError } from "../../errors";
import { requireContentWorkspace } from "../../content-support";
import type { MessageRecord } from "../../types";
import { findThreadRecord } from "../thread/repository";
import { listMessageRecordsByThread } from "../message-repository";

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

export function isContextExcludedMessage(
  message: MessageRecord | null | undefined,
) {
  if (!message?.metadata || typeof message.metadata !== "object") {
    return false;
  }

  const metadata = message.metadata as Record<string, unknown>;
  return metadata.excludeFromContext === true || metadata.isError === true;
}

export function resolveAssistantContextParentId(
  message: MessageRecord | null | undefined,
) {
  if (!message) {
    return null;
  }

  if (!isContextExcludedMessage(message)) {
    return message.id;
  }

  const metadata = message.metadata as Record<string, unknown>;
  if (typeof metadata.sourceAssistantMessageId === "string") {
    return metadata.sourceAssistantMessageId;
  }
  if (typeof metadata.versionOf === "string") {
    return metadata.versionOf;
  }
  return message.parentMessageId;
}

export function resolveSourceIdsFromMessage(
  message: MessageRecord | null | undefined,
): string[] {
  const sourceIds =
    message?.metadata && typeof message.metadata === "object"
      ? (message.metadata as { sourceIds?: unknown }).sourceIds
      : undefined;

  if (!Array.isArray(sourceIds)) {
    return [];
  }

  return sourceIds.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function normalizeVersionComparisonText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
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

export async function resolveImplicitRefreshInput(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  messageContent: string;
  sourceIds: string[];
  existingUserMessage?: MessageRecord;
  userMessageParentId?: string | null;
  assistantMessageParentId?: string | null;
}) {
  if (
    input.existingUserMessage ||
    input.userMessageParentId ||
    input.assistantMessageParentId
  ) {
    return {
      sourceIds: input.sourceIds,
      existingUserMessage: input.existingUserMessage,
      assistantMessageParentId: input.assistantMessageParentId ?? null,
    };
  }

  const messages = collapseSupersededMessages(
    await listMessageRecordsByThread({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
    }),
  ).filter((message) => !isContextExcludedMessage(message));

  const { latestUserMessage, latestAssistantMessage } =
    resolveLatestThreadTurn(messages);

  if (!latestUserMessage || !latestAssistantMessage) {
    return {
      sourceIds: input.sourceIds,
      existingUserMessage: undefined,
      assistantMessageParentId: null,
    };
  }

  if (
    normalizeVersionComparisonText(latestUserMessage.content) !==
    normalizeVersionComparisonText(input.messageContent)
  ) {
    return {
      sourceIds: input.sourceIds,
      existingUserMessage: undefined,
      assistantMessageParentId: null,
    };
  }

  return {
    sourceIds: input.sourceIds,
    existingUserMessage: latestUserMessage,
    assistantMessageParentId: latestAssistantMessage.id,
  };
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

  const messageById = new Map(allMessages.map((message) => [message.id, message]));
  const requestedUserMessage = input.userMessageId
    ? messageById.get(input.userMessageId)
    : undefined;
  const requestedAssistantMessage = input.assistantMessageId
    ? messageById.get(input.assistantMessageId)
    : undefined;

  if (input.userMessageId && !requestedUserMessage) {
    throw new ContentError(
      404,
      "MESSAGE_NOT_FOUND",
      "User message not found",
    );
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
