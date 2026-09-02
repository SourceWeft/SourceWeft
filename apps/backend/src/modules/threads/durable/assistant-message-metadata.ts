import { findMessageRecord, updateMessageRecord } from "../message-repository";
import { preserveTraceMetadata } from "../turn/trace-metadata";
import type { ChatRunSnapshot, ChatThreadRunRecord } from "./types";
import { toObjectRecord } from "../../../shared/records";

export function buildThreadRunMetadata(run: ChatThreadRunRecord) {
  return {
    threadRun: {
      id: run.id,
      idempotencyKey: run.idempotencyKey,
      status: run.status,
      mode: run.mode,
      streamKey: run.streamKey,
      ...(run.assistantMessageId
        ? { assistantMessageId: run.assistantMessageId }
        : {}),
      ...(run.startedAt && run.finishedAt
        ? {
            startedAt: run.startedAt,
            completedAt: run.finishedAt,
          }
        : {}),
    },
  };
}

export function withAssistantThreadRunMetadata(
  snapshot: ChatRunSnapshot,
  run: ChatThreadRunRecord,
) {
  if (!snapshot.assistantMessage) {
    return snapshot;
  }
  return {
    ...snapshot,
    assistantMessage: {
      ...snapshot.assistantMessage,
      metadata: {
        ...snapshot.assistantMessage.metadata,
        ...buildThreadRunMetadata(run),
      },
    },
  };
}

export function resolveAssistantMessageProjection(input: {
  currentContent?: string | null;
  snapshot: ChatRunSnapshot;
}) {
  const { snapshot } = input;
  const assistantMessage = snapshot.assistantMessage;
  const snapshotMessageContent =
    typeof assistantMessage?.content === "string"
      ? assistantMessage.content
      : null;
  const baseContent =
    typeof snapshotMessageContent === "string"
      ? snapshotMessageContent
      : typeof input.currentContent === "string"
        ? input.currentContent
        : "";
  const nextContent =
    typeof snapshot.assistantContent === "string"
      ? snapshot.assistantContent
      : "";
  const content =
    baseContent.length > 0 || nextContent.length > 0
      ? appendAssistantContinuationContentValue({
          existingContent: baseContent,
          nextContent,
        })
      : undefined;
  const contentJson =
    typeof content === "string"
      ? {
          version: 1,
          parts: [{ type: "text", text: content }],
        }
      : assistantMessage?.contentJson &&
          typeof assistantMessage.contentJson === "object" &&
          !Array.isArray(assistantMessage.contentJson)
        ? assistantMessage.contentJson
        : undefined;
  return { content, contentJson };
}

function appendAssistantContinuationContentValue(input: {
  existingContent?: string | null;
  nextContent: string;
}) {
  const existingContent = input.existingContent?.trimEnd() ?? "";
  const nextContent = input.nextContent.trim();
  if (!existingContent) {
    return nextContent;
  }
  if (!nextContent) {
    return existingContent;
  }
  if (nextContent.startsWith(existingContent)) {
    return nextContent;
  }
  if (existingContent.endsWith(nextContent)) {
    return existingContent;
  }

  const maxOverlap = Math.min(existingContent.length, nextContent.length);
  for (let length = maxOverlap; length > 0; length -= 1) {
    if (existingContent.endsWith(nextContent.slice(0, length))) {
      return `${existingContent}${nextContent.slice(length)}`;
    }
  }

  return `${existingContent}\n${nextContent}`;
}

export async function updateAssistantMessageThreadRunMetadata(input: {
  run: ChatThreadRunRecord;
  metadata?: Record<string, unknown>;
  snapshot?: ChatRunSnapshot;
}) {
  if (!input.run.assistantMessageId) {
    return null;
  }
  const current = await findMessageRecord({
    teamId: input.run.teamId,
    workspaceId: input.run.workspaceId,
    messageId: input.run.assistantMessageId,
  });
  if (!current) {
    return null;
  }
  const extraThreadRun = toObjectRecord(input.metadata?.threadRun);
  const snapshotMetadata =
    input.snapshot && current
      ? buildAssistantMessageSnapshotMetadata({
          currentMetadata: current.metadata,
          run: input.run,
          snapshot: input.snapshot,
        })
      : {};
  return updateMessageRecord({
    teamId: input.run.teamId,
    workspaceId: input.run.workspaceId,
    threadId: input.run.threadId,
    messageId: input.run.assistantMessageId,
    metadata: {
      ...current.metadata,
      ...snapshotMetadata,
      ...(input.metadata ?? {}),
      threadRun: {
        ...buildThreadRunMetadata(input.run).threadRun,
        ...(extraThreadRun ?? {}),
      },
    },
    ...(input.snapshot
      ? resolveAssistantMessageProjection({
          currentContent: current.content,
          snapshot: input.snapshot,
        })
      : {}),
  });
}

export async function updateAssistantMessageConfirmationMetadata(input: {
  run: ChatThreadRunRecord;
  snapshot: ChatRunSnapshot;
}) {
  if (!input.run.assistantMessageId) {
    return null;
  }
  const current = await findMessageRecord({
    teamId: input.run.teamId,
    workspaceId: input.run.workspaceId,
    messageId: input.run.assistantMessageId,
  });
  if (!current) {
    return null;
  }
  return updateMessageRecord({
    teamId: input.run.teamId,
    workspaceId: input.run.workspaceId,
    threadId: input.run.threadId,
    messageId: input.run.assistantMessageId,
    metadata: buildAssistantMessageConfirmationMetadata({
      currentMetadata: current.metadata,
      run: input.run,
      snapshot: input.snapshot,
    }),
  });
}

export function buildAssistantMessageSnapshotMetadata(input: {
  currentMetadata: Record<string, unknown>;
  run: ChatThreadRunRecord;
  snapshot: ChatRunSnapshot;
}) {
  const nextMetadata = {
    ...(input.snapshot.reasoning !== undefined
      ? { reasoning: input.snapshot.reasoning }
      : {}),
    ...(input.snapshot.reasoningSegments !== undefined
      ? { reasoningSegments: input.snapshot.reasoningSegments }
      : {}),
    ...(input.snapshot.thinkingSteps !== undefined
      ? { thinkingSteps: input.snapshot.thinkingSteps }
      : {}),
    ...(input.snapshot.traceEvents !== undefined
      ? { traceEvents: input.snapshot.traceEvents }
      : {}),
    ...(input.snapshot.traceParts !== undefined
      ? { traceParts: input.snapshot.traceParts }
      : {}),
    ...(input.snapshot.renderBlocks !== undefined
      ? { renderBlocks: input.snapshot.renderBlocks }
      : {}),
    ...(input.snapshot.agentCheckpoint !== undefined
      ? { agentCheckpoint: input.snapshot.agentCheckpoint }
      : {}),
    ...(input.snapshot.retrieval !== undefined
      ? { retrieval: input.snapshot.retrieval }
      : {}),
    ...(input.snapshot.finishReason !== undefined
      ? { finishReason: input.snapshot.finishReason }
      : {}),
    toolCalls:
      input.snapshot.toolCalls ??
      (Array.isArray(input.currentMetadata.toolCalls)
        ? input.currentMetadata.toolCalls
        : []),
    threadRun: buildThreadRunMetadata(input.run).threadRun,
  };
  return preserveTraceMetadata({
    existingMetadata: input.currentMetadata,
    nextMetadata,
  });
}

export function buildAssistantMessageConfirmationMetadata(input: {
  currentMetadata: Record<string, unknown>;
  run: ChatThreadRunRecord;
  snapshot: ChatRunSnapshot;
}) {
  const currentThreadRun = toObjectRecord(input.currentMetadata.threadRun);
  const threadRun = buildThreadRunMetadata(input.run).threadRun;
  const approvalRequestedAt =
    input.snapshot.approvalRequestedAt ?? currentThreadRun?.approvalRequestedAt;
  const approvalExpiresAt =
    input.snapshot.approvalExpiresAt ?? currentThreadRun?.approvalExpiresAt;
  const nextMetadata = {
    ...(input.snapshot.reasoning !== undefined
      ? { reasoning: input.snapshot.reasoning }
      : {}),
    ...(input.snapshot.reasoningSegments !== undefined
      ? { reasoningSegments: input.snapshot.reasoningSegments }
      : {}),
    ...(input.snapshot.thinkingSteps !== undefined
      ? { thinkingSteps: input.snapshot.thinkingSteps }
      : {}),
    ...(input.snapshot.traceEvents !== undefined
      ? { traceEvents: input.snapshot.traceEvents }
      : {}),
    ...(input.snapshot.traceParts !== undefined
      ? { traceParts: input.snapshot.traceParts }
      : {}),
    ...(input.snapshot.renderBlocks !== undefined
      ? { renderBlocks: input.snapshot.renderBlocks }
      : {}),
    ...(input.snapshot.agentCheckpoint !== undefined
      ? { agentCheckpoint: input.snapshot.agentCheckpoint }
      : {}),
    ...(input.snapshot.retrieval !== undefined
      ? { retrieval: input.snapshot.retrieval }
      : {}),
    threadRun:
      input.run.status === "waiting_for_approval"
        ? {
            ...threadRun,
            ...(typeof approvalRequestedAt === "string"
              ? { approvalRequestedAt }
              : {}),
            ...(typeof approvalExpiresAt === "string"
              ? { approvalExpiresAt }
              : {}),
          }
        : threadRun,
    toolCalls:
      input.snapshot.toolCalls ??
      (Array.isArray(input.currentMetadata.toolCalls)
        ? input.currentMetadata.toolCalls
        : []),
    finishReason:
      input.snapshot.finishReason ?? input.currentMetadata.finishReason,
  };
  return preserveTraceMetadata({
    existingMetadata: input.currentMetadata,
    nextMetadata,
  });
}
