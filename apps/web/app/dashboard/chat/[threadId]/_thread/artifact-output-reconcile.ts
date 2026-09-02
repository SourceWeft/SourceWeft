import type { MessageRenderBlock } from "../../_components/chat-canvas";
import type {
  ChatMessageItem,
  StreamingAssistantSnapshot,
} from "../streaming-assistant-state";
import { toObjectRecord } from "../../../../../lib/records";

export type ArtifactOutputReconcileTarget = {
  assistantMessageId?: string | null;
  runId?: string | null;
};

type ArtifactOutputBlock = Extract<
  MessageRenderBlock,
  { type: "artifact_output" }
>;

// Reference equality is useless here: `authoritative` is a fresh REST/SSE
// fetch every reconcile, so its objects never share identity with what's
// already in state even when nothing actually changed server-side. Fall back
// to a value comparison, scoped to just the entries being substituted (a
// handful of artifact-related blocks/tool calls, not the whole message) so
// repeated reconciles of already-committed data can report "no change" and
// let the caller skip rebuilding the message/array.
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function normalizeArtifactOutputBlock(
  value: unknown,
): ArtifactOutputBlock | null {
  const record = toObjectRecord(value);
  const producer = toObjectRecord(record?.producer);
  const producerKind = producer?.kind;
  if (
    record?.type !== "artifact_output" ||
    typeof record.id !== "string" ||
    typeof record.artifactId !== "string" ||
    typeof record.artifactVersionId !== "string" ||
    typeof record.sourceToolCallId !== "string" ||
    typeof record.threadRunId !== "string" ||
    typeof record.sequence !== "number" ||
    !Number.isFinite(record.sequence) ||
    (producerKind !== "main" && producerKind !== "subagent")
  ) {
    return null;
  }

  return {
    artifactId: record.artifactId,
    artifactVersionId: record.artifactVersionId,
    id: record.id,
    placement: "terminal",
    producer: {
      kind: producerKind,
      ...(typeof producer?.subagentType === "string"
        ? { subagentType: producer.subagentType }
        : {}),
    },
    sequence: record.sequence,
    sourceToolCallId: record.sourceToolCallId,
    threadRunId: record.threadRunId,
    type: "artifact_output",
  };
}

function artifactOutputBlocks(message: ChatMessageItem) {
  const blocks = Array.isArray(message.metadata.renderBlocks)
    ? message.metadata.renderBlocks
    : [];
  return blocks
    .map(normalizeArtifactOutputBlock)
    .filter((block): block is ArtifactOutputBlock => block !== null);
}

function producerMatchesArtifactOutput(input: {
  block: ArtifactOutputBlock;
  toolCall: Record<string, unknown>;
}) {
  const producer = toObjectRecord(input.toolCall.producer);
  const kind = producer?.kind ?? "main";
  return (
    kind === input.block.producer.kind &&
    producer?.subagentType === input.block.producer.subagentType
  );
}

/**
 * The atomic publisher writes a completed tool call and its artifact block in
 * the same transaction. Only that paired identity is safe to promote over a
 * still-running local stream projection; unrelated REST tool calls may lag and
 * remain owned by the live stream.
 */
function committedArtifactToolCalls(
  message: ChatMessageItem,
  blocks: readonly ArtifactOutputBlock[],
) {
  const blockByToolCallId = new Map(
    blocks.map((block) => [block.sourceToolCallId, block]),
  );
  const calls = Array.isArray(message.metadata.toolCalls)
    ? message.metadata.toolCalls
    : [];
  return calls.flatMap((value) => {
    const call = toObjectRecord(value);
    const output = toObjectRecord(call?.output);
    const id = typeof call?.id === "string" ? call.id : null;
    const block = id ? blockByToolCallId.get(id) : undefined;
    if (
      !call ||
      !id ||
      !block ||
      typeof call.tool !== "string" ||
      call.status !== "completed" ||
      Boolean(call.error) ||
      output?.status !== "ready" ||
      output.type !== "committed_artifact_result" ||
      typeof output.artifactType !== "string" ||
      typeof output.workflowVersion !== "string" ||
      output.artifactId !== block.artifactId ||
      output.artifactVersionId !== block.artifactVersionId ||
      output.artifactOutputBlockId !== block.id ||
      !producerMatchesArtifactOutput({ block, toolCall: call })
    ) {
      return [];
    }
    return [call];
  });
}

function mergeCommittedArtifactToolCalls(input: {
  authoritative: readonly Record<string, unknown>[];
  current: unknown;
}): { changed: boolean; merged: unknown[] } | null {
  if (input.authoritative.length === 0) {
    return null;
  }
  const authoritativeById = new Map(
    input.authoritative.map((call) => [call.id as string, call]),
  );
  const current = Array.isArray(input.current) ? input.current : [];
  const merged: unknown[] = [];
  const seen = new Set<string>();
  let changed = false;
  for (const value of current) {
    const record = toObjectRecord(value);
    const id = typeof record?.id === "string" ? record.id : null;
    if (!id) {
      merged.push(value);
      continue;
    }
    if (seen.has(id)) {
      // A duplicate id is itself a change worth flushing.
      changed = true;
      continue;
    }
    seen.add(id);
    const authoritativeCall = authoritativeById.get(id);
    if (authoritativeCall === undefined) {
      merged.push(value);
      continue;
    }
    if (!sameJson(value, authoritativeCall)) {
      changed = true;
    }
    merged.push(authoritativeCall);
  }
  for (const [id, call] of authoritativeById) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    merged.push(call);
    changed = true;
  }
  return { changed, merged };
}

function messageRunId(message: ChatMessageItem) {
  const threadRun = toObjectRecord(message.metadata.threadRun);
  return typeof threadRun?.id === "string" ? threadRun.id : null;
}

function hasTargetArtifactOutput(
  message: ChatMessageItem,
  target: ArtifactOutputReconcileTarget,
) {
  const blocks = artifactOutputBlocks(message);
  return blocks.some(
    (block) => !target.runId || block.threadRunId === target.runId,
  );
}

export function findArtifactOutputMessage(input: {
  messages: ChatMessageItem[];
  target: ArtifactOutputReconcileTarget;
}): ChatMessageItem | null {
  const { messages, target } = input;
  if (target.assistantMessageId) {
    const exact = messages.find(
      (message) =>
        message.id === target.assistantMessageId &&
        hasTargetArtifactOutput(message, target),
    );
    if (exact) {
      return exact;
    }
  }
  if (!target.runId) {
    return null;
  }
  return (
    messages.find((message) =>
      artifactOutputBlocks(message).some(
        (block) => block.threadRunId === target.runId,
      ),
    ) ?? null
  );
}

function messageMatchesTarget(input: {
  authoritativeMessageId: string;
  message: ChatMessageItem;
  target: ArtifactOutputReconcileTarget;
}) {
  return (
    input.message.id === input.authoritativeMessageId ||
    (Boolean(input.target.assistantMessageId) &&
      input.message.id === input.target.assistantMessageId) ||
    (Boolean(input.target.runId) &&
      messageRunId(input.message) === input.target.runId)
  );
}

export function mergeCommittedArtifactOutputsIntoMessage(input: {
  authoritative: ChatMessageItem;
  current: ChatMessageItem;
}): ChatMessageItem {
  const authoritativeBlocks = artifactOutputBlocks(input.authoritative);
  if (authoritativeBlocks.length === 0) {
    return input.current;
  }
  const authoritativeToolCalls = committedArtifactToolCalls(
    input.authoritative,
    authoritativeBlocks,
  );
  const mergedToolCalls = mergeCommittedArtifactToolCalls({
    authoritative: authoritativeToolCalls,
    current: input.current.metadata.toolCalls,
  });

  const currentBlocks = Array.isArray(input.current.metadata.renderBlocks)
    ? input.current.metadata.renderBlocks
    : [];
  const authoritativeById = new Map(
    authoritativeBlocks.map((block) => [block.id, block]),
  );
  const seen = new Set<string>();
  let blocksChanged = false;
  const merged = currentBlocks.flatMap((block) => {
    const record = toObjectRecord(block);
    const id = typeof record?.id === "string" ? record.id : null;
    if (!id || !authoritativeById.has(id)) {
      return [block];
    }
    if (seen.has(id)) {
      blocksChanged = true;
      return [];
    }
    seen.add(id);
    const authoritativeBlock = authoritativeById.get(id)!;
    if (!sameJson(record, authoritativeBlock)) {
      blocksChanged = true;
    }
    return [authoritativeBlock];
  });
  for (const block of authoritativeBlocks) {
    if (!seen.has(block.id)) {
      seen.add(block.id);
      merged.push(block);
      blocksChanged = true;
    }
  }

  // Every reconcile refetches `authoritative` fresh, so its objects never
  // share identity with what's already merged into `current` even when the
  // committed data hasn't changed since the last reconcile. Without this
  // value-based check, this function would always return a new object/array
  // whenever any authoritative block exists, making the identity short-circuit
  // in mergeCommittedArtifactOutputsIntoMessages (and the streaming-snapshot
  // equivalent) permanently unreachable — every ~15s presence heartbeat and
  // poll would rebuild the message (and its containing array) for no reason.
  if (!blocksChanged && !mergedToolCalls?.changed) {
    return input.current;
  }

  return {
    ...input.current,
    metadata: {
      ...input.current.metadata,
      renderBlocks: merged,
      ...(mergedToolCalls ? { toolCalls: mergedToolCalls.merged } : {}),
    },
  };
}

export function mergeCommittedArtifactOutputsIntoMessages(input: {
  authoritative: ChatMessageItem;
  current: ChatMessageItem[];
  target: ArtifactOutputReconcileTarget;
}): ChatMessageItem[] {
  const index = input.current.findIndex((message) =>
    messageMatchesTarget({
      authoritativeMessageId: input.authoritative.id,
      message,
      target: input.target,
    }),
  );
  if (index < 0) {
    return input.current;
  }
  const currentMessage = input.current[index]!;
  const mergedMessage = mergeCommittedArtifactOutputsIntoMessage({
    authoritative: input.authoritative,
    current: currentMessage,
  });
  if (mergedMessage === currentMessage) {
    return input.current;
  }
  const next = [...input.current];
  next[index] = mergedMessage;
  return next;
}

export function mergeCommittedArtifactOutputsIntoStreamingSnapshot(input: {
  authoritative: ChatMessageItem;
  current: StreamingAssistantSnapshot | null;
  target: ArtifactOutputReconcileTarget;
}): StreamingAssistantSnapshot | null {
  if (!input.current) {
    return null;
  }
  const matches =
    input.current.messageId === input.authoritative.id ||
    input.current.messageIds.includes(input.authoritative.id) ||
    messageMatchesTarget({
      authoritativeMessageId: input.authoritative.id,
      message: input.current.message,
      target: input.target,
    });
  if (!matches) {
    return input.current;
  }
  const message = mergeCommittedArtifactOutputsIntoMessage({
    authoritative: input.authoritative,
    current: input.current.message,
  });
  if (message === input.current.message) {
    return input.current;
  }
  return {
    ...input.current,
    message,
    messageIds: Array.from(
      new Set([...input.current.messageIds, input.authoritative.id]),
    ),
    renderVersion: input.current.renderVersion + 1,
  };
}
