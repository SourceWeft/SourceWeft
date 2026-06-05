import type {
  ChatSendInput,
  CitationRecord,
  MessageVersion,
  VersionedMessageGroup,
} from "../../_components/chat-canvas";
import type { ChatMessageItem } from "../streaming-assistant-state";
import {
  hasRenderBlocksMetadata,
  resolveCitationMetadata,
  resolveModelReasoningFromMetadata,
  resolveModelReasoningSegmentsFromMetadata,
  resolveReasoningTraceEventsFromMetadata,
  resolveRenderBlocksFromMetadata,
  resolveThinkingStepsFromMetadata,
  resolveTracePartsFromMetadata,
  resolveToolCallsFromMetadata,
  sanitizeClientErrorMessage,
  STREAM_RENDER_KEY,
  STREAM_TEXT_INTERRUPTED_KEY,
  STREAM_TEXT_PAUSED_KEY,
  toNullableNumber,
  toNullableString,
  toObjectRecord,
} from "./message-normalizers";

const EMPTY_CITATIONS: CitationRecord[] = [];

type PendingLatestVersionSelection = {
  userGroupId?: string;
  assistantGroupId?: string;
  turnId?: string;
};

function resolveMessageSourceIds(message: ChatMessageItem) {
  const rawSourceIds = message.metadata.sourceIds;
  if (!Array.isArray(rawSourceIds)) {
    return [] as string[];
  }

  return rawSourceIds.filter(
    (sourceId): sourceId is string => typeof sourceId === "string",
  );
}

function resolveMessageEffectiveSourceIds(message: ChatMessageItem) {
  const rawSourceIds = message.metadata.effectiveSourceIds;
  if (!Array.isArray(rawSourceIds)) {
    return undefined;
  }

  return rawSourceIds.filter(
    (sourceId): sourceId is string => typeof sourceId === "string",
  );
}

function resolveMessageMentionedSourceIds(message: ChatMessageItem) {
  const rawSourceIds = message.metadata.mentionedSourceIds;
  if (!Array.isArray(rawSourceIds)) {
    return [] as string[];
  }

  return rawSourceIds.filter(
    (sourceId): sourceId is string => typeof sourceId === "string",
  );
}

function resolveMessageEffectiveMentionedSourceIds(message: ChatMessageItem) {
  const rawSourceIds = message.metadata.effectiveMentionedSourceIds;
  if (!Array.isArray(rawSourceIds)) {
    return undefined;
  }

  return rawSourceIds.filter(
    (sourceId): sourceId is string => typeof sourceId === "string",
  );
}

const CITATION_PATTERN =
  /[[【]\u200B?citation:\s*([\w:-]+(?:\s*,\s*[\w:-]+)*)\s*\u200B?[\]】]/g;

function splitCitationIds(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function resolveUsedCitationsForText(input: {
  citations: CitationRecord[] | undefined;
  text: string;
}) {
  const citationByKey = new Map(
    (input.citations ?? []).map((citation) => [citation.citation, citation]),
  );
  const citationByChunkId = new Map(
    (input.citations ?? []).map((citation) => [citation.chunkId, citation]),
  );
  const used: CitationRecord[] = [];
  const seen = new Set<string>();

  const pushCitation = (id: string) => {
    const citation = citationByKey.get(id) ?? citationByChunkId.get(id);
    if (!citation || seen.has(citation.chunkId)) {
      return;
    }
    seen.add(citation.chunkId);
    used.push(citation);
  };

  CITATION_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CITATION_PATTERN.exec(input.text)) !== null) {
    splitCitationIds(match[1] ?? "").forEach(pushCitation);
  }

  return used;
}

function resolveActiveAssistantVersion(input: {
  activeVersionByGroup: Record<string, number>;
  group: VersionedMessageGroup;
  groups: VersionedMessageGroup[];
}): MessageVersion | null {
  if (input.group.role !== "assistant") {
    return null;
  }

  const userGroup = input.group.turnId
    ? input.groups.find(
        (candidate) =>
          candidate.role === "user" && candidate.turnId === input.group.turnId,
      )
    : null;
  const selectedUserVersionId = userGroup
    ? (() => {
        const latestUserVersionIndex = Math.max(
          userGroup.versions.length - 1,
          0,
        );
        const activeUserBranchIndex = Math.min(
          Math.max(
            input.activeVersionByGroup[userGroup.groupId] ??
              latestUserVersionIndex,
            0,
          ),
          latestUserVersionIndex,
        );
        return userGroup.versions[activeUserBranchIndex]?.id ?? null;
      })()
    : null;

  const versionEntries = input.group.versions.map((version, originalIndex) => ({
    version,
    originalIndex,
  }));
  const scopedEntries = selectedUserVersionId
    ? versionEntries.filter(
        (entry) => entry.version.sourceUserMessageId === selectedUserVersionId,
      )
    : versionEntries;
  const visibleEntries =
    scopedEntries.length > 0 ? scopedEntries : versionEntries;
  const latestVisibleIndex = Math.max(visibleEntries.length - 1, 0);
  const desiredOriginalIndex =
    input.activeVersionByGroup[input.group.groupId] ??
    visibleEntries[latestVisibleIndex]?.originalIndex ??
    0;
  const matchedVisibleIndex = visibleEntries.findIndex(
    (entry) => entry.originalIndex === desiredOriginalIndex,
  );
  const activeVisibleIndex =
    matchedVisibleIndex >= 0 ? matchedVisibleIndex : latestVisibleIndex;

  return visibleEntries[activeVisibleIndex]?.version ?? null;
}

function resolveContextSourceIds(input: {
  messages: ChatMessageItem[];
  activeSourceIds: string[];
}) {
  if (input.activeSourceIds.length > 0) {
    return input.activeSourceIds;
  }

  const sourceIds: string[] = [];
  const seen = new Set<string>();
  for (const message of input.messages) {
    for (const sourceId of resolveMessageSourceIds(message)) {
      if (!seen.has(sourceId)) {
        seen.add(sourceId);
        sourceIds.push(sourceId);
      }
    }
  }
  return sourceIds;
}

function resolveRefreshSourceIds(input: {
  activeSourceIds?: string[];
  assistantMessageId: string;
  groups: VersionedMessageGroup[];
}) {
  const assistantVersion = input.groups
    .flatMap((group) => group.versions)
    .find((version) => version.id === input.assistantMessageId);
  const sourceUserMessageId = assistantVersion?.sourceUserMessageId;
  if (!sourceUserMessageId) {
    return [] as string[];
  }

  const userVersion = input.groups
    .filter((group) => group.role === "user")
    .flatMap((group) => group.versions)
    .find((version) => version.id === sourceUserMessageId);

  const sourceIds = userVersion?.sourceIds ?? [];
  if (sourceIds.length > 0) {
    return sourceIds;
  }

  return input.activeSourceIds ?? [];
}

function resolveEditSourceIds(input: {
  activeSourceIds: string[];
  editingMessageId: string;
  groups: VersionedMessageGroup[];
}) {
  if (input.activeSourceIds.length > 0) {
    return input.activeSourceIds;
  }

  const userVersion = input.groups
    .filter((group) => group.role === "user")
    .flatMap((group) => group.versions)
    .find((version) => version.id === input.editingMessageId);

  return userVersion?.sourceIds ?? [];
}

function resolveAssistantSourceUserMessageId(
  message: ChatMessageItem,
  fallbackUserMessageId: string | null,
) {
  const candidate =
    message.metadata.userMessageId ??
    message.metadata.sourceUserMessageId ??
    message.metadata.promptMessageId;

  if (typeof candidate === "string" && candidate.length > 0) {
    return candidate;
  }

  return fallbackUserMessageId;
}

function buildVersionedMessageGroups(
  messages: ChatMessageItem[],
): VersionedMessageGroup[] {
  const messagesById = new Map<string, ChatMessageItem>();
  for (const message of messages) {
    messagesById.set(message.id, message);
  }

  const sorted = [...messagesById.values()].sort(
    (left, right) =>
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
  );
  const messageById = new Map(sorted.map((message) => [message.id, message]));
  const rootIdCache = new Map<string, string>();

  const resolveRootId = (message: ChatMessageItem) => {
    const cached = rootIdCache.get(message.id);
    if (cached) {
      return cached;
    }

    let current: ChatMessageItem | undefined = message;
    while (current?.parentMessageId) {
      const parent = messageById.get(current.parentMessageId);
      if (!parent) {
        break;
      }
      current = parent;
    }
    const rootId = current?.id ?? message.id;
    rootIdCache.set(message.id, rootId);
    return rootId;
  };

  const rootIdsInOrder: string[] = [];
  const seenRootIds = new Set<string>();
  for (const message of sorted) {
    const rootId = resolveRootId(message);
    if (seenRootIds.has(rootId)) {
      continue;
    }
    seenRootIds.add(rootId);
    rootIdsInOrder.push(rootId);
  }

  const assistantSourceUserById = new Map<string, string | null>();
  let latestUserMessageId: string | null = null;
  for (const message of sorted) {
    if (message.role === "user") {
      latestUserMessageId = message.id;
      continue;
    }

    if (message.role === "assistant") {
      assistantSourceUserById.set(
        message.id,
        resolveAssistantSourceUserMessageId(message, latestUserMessageId),
      );
    }
  }

  const turns: Array<{
    turnId: string;
    userRootId: string | null;
    assistantRootId: string | null;
    createdAt: string;
  }> = [];

  for (const rootId of rootIdsInOrder) {
    const rootMessage = messageById.get(rootId);
    if (!rootMessage) {
      continue;
    }

    if (rootMessage.role === "user") {
      turns.push({
        turnId: `turn:${rootMessage.id}`,
        userRootId: rootMessage.id,
        assistantRootId: null,
        createdAt: rootMessage.createdAt,
      });
      continue;
    }

    if (rootMessage.role !== "assistant") {
      continue;
    }

    const sourceUserMessageId = assistantSourceUserById.get(rootMessage.id);
    const sourceUserRootId =
      sourceUserMessageId && messageById.has(sourceUserMessageId)
        ? resolveRootId(messageById.get(sourceUserMessageId)!)
        : null;
    const sourceTurn = sourceUserRootId
      ? [...turns]
          .reverse()
          .find((turn) => turn.userRootId === sourceUserRootId)
      : null;
    if (sourceTurn) {
      const existingAssistant = sourceTurn.assistantRootId
        ? messageById.get(sourceTurn.assistantRootId)
        : null;
      if (
        !existingAssistant ||
        (existingAssistant.metadata.isError === true &&
          rootMessage.metadata.isError !== true)
      ) {
        sourceTurn.assistantRootId = rootMessage.id;
      }
      continue;
    }

    const openTurn = [...turns].reverse().find((turn) => !turn.assistantRootId);
    if (openTurn) {
      openTurn.assistantRootId = rootMessage.id;
      continue;
    }

    const latestTurn = turns[turns.length - 1];
    if (latestTurn) {
      latestTurn.assistantRootId = rootMessage.id;
      continue;
    }

    turns.push({
      turnId: `turn:${rootMessage.id}`,
      userRootId: null,
      assistantRootId: rootMessage.id,
      createdAt: rootMessage.createdAt,
    });
  }

  const userRootToTurnId = new Map<string, string>();
  const assistantRootToTurnId = new Map<string, string>();
  const turnOrder = new Map<string, number>();
  turns.forEach((turn, index) => {
    turnOrder.set(turn.turnId, index);
    if (turn.userRootId) {
      userRootToTurnId.set(turn.userRootId, turn.turnId);
    }
    if (turn.assistantRootId) {
      assistantRootToTurnId.set(turn.assistantRootId, turn.turnId);
    }
  });

  const assistantRootBySourceUserId = new Map<string, string>();
  for (const message of sorted) {
    if (message.role !== "assistant") {
      continue;
    }

    const sourceUserMessageId = assistantSourceUserById.get(message.id);
    if (!sourceUserMessageId || !messageById.has(sourceUserMessageId)) {
      continue;
    }

    const sourceUserMessage = messageById.get(sourceUserMessageId);
    if (!sourceUserMessage) {
      continue;
    }

    const sourceUserRootId = resolveRootId(sourceUserMessage);
    const rootId = resolveRootId(message);
    const existingRootId = assistantRootBySourceUserId.get(sourceUserRootId);
    if (!existingRootId) {
      assistantRootBySourceUserId.set(sourceUserRootId, rootId);
      continue;
    }

    const existing = messageById.get(existingRootId);
    const candidate = messageById.get(rootId);
    if (
      existing?.metadata.isError === true &&
      candidate?.metadata.isError !== true
    ) {
      assistantRootBySourceUserId.set(sourceUserRootId, rootId);
    }
  }

  const grouped = new Map<
    string,
    {
      turnId: string;
      role: "user" | "assistant";
      versions: ChatMessageItem[];
    }
  >();

  for (const message of sorted) {
    const sourceUserMessageId =
      message.role === "assistant"
        ? assistantSourceUserById.get(message.id)
        : null;
    const sourceUserRootId =
      sourceUserMessageId && messageById.has(sourceUserMessageId)
        ? resolveRootId(messageById.get(sourceUserMessageId)!)
        : null;
    const rootId =
      message.role === "assistant" && sourceUserRootId
        ? (assistantRootBySourceUserId.get(sourceUserRootId) ??
          resolveRootId(message))
        : resolveRootId(message);
    const turnId =
      message.role === "user"
        ? (userRootToTurnId.get(rootId) ?? `turn:${rootId}`)
        : (assistantRootToTurnId.get(rootId) ?? `turn:${rootId}`);
    const groupId = `${message.role}:${rootId}`;
    const existing = grouped.get(groupId);
    if (existing) {
      existing.versions.push(message);
    } else {
      grouped.set(groupId, {
        turnId,
        role: message.role,
        versions: [message],
      });
    }
  }

  return [...grouped.entries()]
    .map(([groupId, group]) => {
      const sortedVersions = [...group.versions].sort(
        (left, right) =>
          new Date(left.createdAt).getTime() -
          new Date(right.createdAt).getTime(),
      );
      const latestVersion =
        sortedVersions[sortedVersions.length - 1] ?? sortedVersions[0];

      return {
        groupId,
        turnId: group.turnId,
        latestVersionId: latestVersion?.id ?? groupId,
        role: group.role,
        versions: sortedVersions.map((version) => {
          const citationMetadata =
            group.role === "assistant"
              ? resolveCitationMetadata(version.metadata)
              : null;
          const threadRun =
            group.role === "assistant"
              ? toObjectRecord(version.metadata.threadRun)
              : null;

          return {
            id: version.id,
            renderKey:
              toNullableString(version.metadata[STREAM_RENDER_KEY]) ??
              undefined,
            createdAt: version.createdAt,
            content: version.content,
            contentJson: version.contentJson,
            command:
              group.role === "user"
                ? ((toObjectRecord(version.metadata.command) ??
                    undefined) as ChatSendInput["command"] | undefined)
                : undefined,
            citations: citationMetadata?.citations,
            availableCitations: citationMetadata?.availableCitations,
            isError: version.metadata.isError === true,
            isCancelled:
              version.metadata.isCancelled === true ||
              version.metadata.errorCode === "CLIENT_CANCELLED" ||
              toObjectRecord(version.metadata.threadRun)?.status ===
                "cancelled",
            error: sanitizeClientErrorMessage(
              toNullableString(version.metadata.error),
            ),
            errorCode: toNullableString(version.metadata.errorCode),
            finishReason:
              group.role === "assistant"
                ? (toNullableString(version.metadata.finishReason) ??
                  undefined)
                : undefined,
            threadRun:
              group.role === "assistant" && threadRun
                ? {
                    id: toNullableString(threadRun.id) ?? undefined,
                    idempotencyKey:
                      toNullableString(threadRun.idempotencyKey) ?? undefined,
                    status: toNullableString(threadRun.status) ?? undefined,
                    mode:
                      threadRun.mode === "send" ||
                      threadRun.mode === "refresh" ||
                      threadRun.mode === "edit" ||
                      threadRun.mode === "resume"
                        ? threadRun.mode
                        : undefined,
                    approvalRequestedAt: toNullableString(
                      threadRun.approvalRequestedAt,
                    ),
                    approvalExpiresAt: toNullableString(
                      threadRun.approvalExpiresAt,
                    ),
                    startedAt: toNullableString(threadRun.startedAt),
                    completedAt: toNullableString(threadRun.completedAt),
                    durationMs: toNullableNumber(threadRun.durationMs),
                  }
                : undefined,
            isTextPaused: version.metadata[STREAM_TEXT_PAUSED_KEY] === true,
            isTextInterrupted:
              version.metadata[STREAM_TEXT_INTERRUPTED_KEY] === true,
            mentionedSourceIds:
              group.role === "user"
                ? resolveMessageMentionedSourceIds(version)
                : undefined,
            effectiveMentionedSourceIds:
              group.role === "user"
                ? resolveMessageEffectiveMentionedSourceIds(version)
                : undefined,
            sourceIds:
              group.role === "user"
                ? resolveMessageSourceIds(version)
                : undefined,
            effectiveSourceIds:
              group.role === "user"
                ? resolveMessageEffectiveSourceIds(version)
                : undefined,
            sourceAssistantMessageId:
              group.role === "assistant"
                ? (toNullableString(
                    version.metadata.sourceAssistantMessageId,
                  ) ?? null)
                : undefined,
            sourceUserMessageId:
              group.role === "assistant"
                ? (assistantSourceUserById.get(version.id) ?? null)
                : undefined,
            toolCalls: resolveToolCallsFromMetadata(version.metadata),
            renderBlocks:
              group.role === "assistant" &&
              hasRenderBlocksMetadata(version.metadata)
                ? resolveRenderBlocksFromMetadata(version.metadata)
                : undefined,
            thinkingSteps:
              group.role === "assistant"
                ? resolveThinkingStepsFromMetadata(version.metadata)
                : undefined,
            modelReasoning:
              group.role === "assistant"
                ? resolveModelReasoningFromMetadata(version.metadata)
                : undefined,
            modelReasoningSegments:
              group.role === "assistant"
                ? resolveModelReasoningSegmentsFromMetadata(version.metadata)
                : undefined,
            traceEvents:
              group.role === "assistant"
                ? resolveReasoningTraceEventsFromMetadata(version.metadata)
                : undefined,
            traceParts:
              group.role === "assistant"
                ? resolveTracePartsFromMetadata(version.metadata)
                : undefined,
          };
        }),
      } satisfies VersionedMessageGroup;
    })
    .sort((left, right) => {
      const leftTurnOrder =
        turnOrder.get(left.turnId ?? "") ?? Number.MAX_SAFE_INTEGER;
      const rightTurnOrder =
        turnOrder.get(right.turnId ?? "") ?? Number.MAX_SAFE_INTEGER;
      if (leftTurnOrder !== rightTurnOrder) {
        return leftTurnOrder - rightTurnOrder;
      }

      if (left.role !== right.role) {
        return left.role === "user" ? -1 : 1;
      }

      const leftFirst = grouped.get(left.groupId)?.versions[0];
      const rightFirst = grouped.get(right.groupId)?.versions[0];
      return (
        new Date(leftFirst?.createdAt ?? 0).getTime() -
        new Date(rightFirst?.createdAt ?? 0).getTime()
      );
    });
}

export {
  buildVersionedMessageGroups,
  EMPTY_CITATIONS,
  resolveActiveAssistantVersion,
  resolveContextSourceIds,
  resolveEditSourceIds,
  resolveMessageEffectiveSourceIds,
  resolveMessageSourceIds,
  resolveRefreshSourceIds,
  resolveUsedCitationsForText,
};
export type { PendingLatestVersionSelection };
