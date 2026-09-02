import { toObjectRecord } from "../../shared/records";
function getCommittedArtifactBlockId(value: unknown): string | null {
  const record = toObjectRecord(value);
  return record?.type === "artifact_output" && typeof record.id === "string"
    ? record.id
    : null;
}

function getCommittedArtifactToolCall(
  value: unknown,
  blocksById: ReadonlyMap<string, Record<string, unknown>>,
) {
  const call = toObjectRecord(value);
  const output = toObjectRecord(call?.output);
  if (
    !call ||
    typeof call.id !== "string" ||
    typeof call.tool !== "string" ||
    call.status !== "completed" ||
    output?.status !== "ready" ||
    output.type !== "committed_artifact_result" ||
    typeof output.artifactType !== "string" ||
    typeof output.artifactId !== "string" ||
    typeof output.artifactVersionId !== "string" ||
    typeof output.artifactOutputBlockId !== "string" ||
    typeof output.workflowVersion !== "string"
  ) {
    return null;
  }
  const block = blocksById.get(output.artifactOutputBlockId);
  const callProducer = toObjectRecord(call.producer);
  const blockProducer = toObjectRecord(block?.producer);
  if (
    !block ||
    block.type !== "artifact_output" ||
    block.artifactId !== output.artifactId ||
    block.artifactVersionId !== output.artifactVersionId ||
    block.sourceToolCallId !== call.id ||
    block.placement !== "terminal" ||
    blockProducer?.kind !== (callProducer?.kind ?? "main") ||
    blockProducer?.subagentType !== callProducer?.subagentType
  ) {
    return null;
  }
  return { call, output };
}

function committedArtifactToolCallIdentityMatches(
  left: unknown,
  right: unknown,
) {
  const leftCall = toObjectRecord(left);
  const rightCall = toObjectRecord(right);
  const leftOutput = toObjectRecord(leftCall?.output);
  const rightOutput = toObjectRecord(rightCall?.output);
  return (
    leftCall?.id === rightCall?.id &&
    leftCall?.tool === rightCall?.tool &&
    leftOutput?.status === rightOutput?.status &&
    leftOutput?.type === rightOutput?.type &&
    leftOutput?.artifactType === rightOutput?.artifactType &&
    leftOutput?.artifactId === rightOutput?.artifactId &&
    leftOutput?.artifactVersionId === rightOutput?.artifactVersionId &&
    leftOutput?.artifactOutputBlockId === rightOutput?.artifactOutputBlockId &&
    leftOutput?.workflowVersion === rightOutput?.workflowVersion
  );
}

function applyCommittedArtifactToolCall(
  incoming: unknown,
  authoritative: unknown,
) {
  const incomingRecord = toObjectRecord(incoming);
  const authoritativeRecord = toObjectRecord(authoritative);
  if (!authoritativeRecord) {
    return incoming;
  }
  if (!incomingRecord) {
    return authoritative;
  }
  const producer = authoritativeRecord.producer ?? incomingRecord.producer;
  // Runtime-owned timing/input fields may become more complete after commit,
  // but the host-committed identity/output and terminal success cannot be
  // downgraded by that later projection.
  return {
    ...authoritativeRecord,
    ...incomingRecord,
    id: authoritativeRecord.id,
    tool: authoritativeRecord.tool,
    output: authoritativeRecord.output,
    status: authoritativeRecord.status,
    error: authoritativeRecord.error,
    ...(producer !== undefined ? { producer } : {}),
  };
}

export function committedArtifactBlockIdentityMatches(
  left: unknown,
  right: unknown,
) {
  const leftRecord = toObjectRecord(left);
  const rightRecord = toObjectRecord(right);
  const leftProducer = toObjectRecord(leftRecord?.producer);
  const rightProducer = toObjectRecord(rightRecord?.producer);
  return (
    leftRecord?.type === "artifact_output" &&
    rightRecord?.type === "artifact_output" &&
    leftRecord.id === rightRecord.id &&
    leftRecord.artifactId === rightRecord.artifactId &&
    leftRecord.artifactVersionId === rightRecord.artifactVersionId &&
    leftRecord.threadRunId === rightRecord.threadRunId &&
    leftRecord.sourceToolCallId === rightRecord.sourceToolCallId &&
    leftRecord.placement === rightRecord.placement &&
    leftProducer?.kind === rightProducer?.kind &&
    leftProducer?.subagentType === rightProducer?.subagentType
  );
}

/**
 * Merge immutable artifact receipts into a newer render-block projection.
 * Non-artifact blocks remain owned by the incoming projection.
 */
export function mergeCommittedArtifactRenderBlocks(input: {
  incoming?: unknown[];
  authoritative: ReadonlyArray<unknown[] | undefined>;
}): unknown[] | undefined {
  const authoritativeById = new Map<string, unknown>();
  for (const blocks of input.authoritative) {
    for (const block of blocks ?? []) {
      const id = getCommittedArtifactBlockId(block);
      if (!id) {
        continue;
      }
      const existing = authoritativeById.get(id);
      if (existing && !committedArtifactBlockIdentityMatches(existing, block)) {
        throw new Error(
          `ARTIFACT_OUTPUT_AUTHORITY_CONFLICT: committed block ${id} has different identity`,
        );
      }
      if (!existing) {
        authoritativeById.set(id, block);
      }
    }
  }

  if (!input.incoming && authoritativeById.size === 0) {
    return undefined;
  }

  const merged: unknown[] = [];
  const seenArtifactIds = new Set<string>();
  for (const block of input.incoming ?? []) {
    const id = getCommittedArtifactBlockId(block);
    if (!id) {
      merged.push(block);
      continue;
    }
    if (seenArtifactIds.has(id)) {
      continue;
    }
    seenArtifactIds.add(id);
    merged.push(authoritativeById.get(id) ?? block);
  }
  for (const [id, block] of authoritativeById) {
    if (seenArtifactIds.has(id)) {
      continue;
    }
    seenArtifactIds.add(id);
    merged.push(block);
  }
  return merged;
}

/**
 * Preserve only host-verifiable committed publisher outputs across stale
 * runner/message projections. The matching artifact-output block is the proof:
 * a model-authored object that merely resembles the terminal schema is not
 * authoritative and receives no special merge treatment.
 */
export function mergeCommittedArtifactToolCalls(input: {
  incoming?: unknown[];
  authoritative: ReadonlyArray<{
    renderBlocks?: unknown[];
    toolCalls?: unknown[];
  }>;
}): unknown[] | undefined {
  const authoritativeById = new Map<string, unknown>();
  for (const projection of input.authoritative) {
    const blocksById = new Map<string, Record<string, unknown>>();
    for (const block of projection.renderBlocks ?? []) {
      const id = getCommittedArtifactBlockId(block);
      const record = toObjectRecord(block);
      if (id && record) {
        blocksById.set(id, record);
      }
    }
    for (const call of projection.toolCalls ?? []) {
      const committed = getCommittedArtifactToolCall(call, blocksById);
      if (!committed) {
        continue;
      }
      const existing = authoritativeById.get(committed.call.id as string);
      if (
        existing &&
        !committedArtifactToolCallIdentityMatches(existing, committed.call)
      ) {
        throw new Error(
          `ARTIFACT_TOOL_OUTPUT_AUTHORITY_CONFLICT: tool call ${committed.call.id as string} has different committed identity`,
        );
      }
      if (!existing) {
        authoritativeById.set(committed.call.id as string, committed.call);
      }
    }
  }

  if (!input.incoming && authoritativeById.size === 0) {
    return undefined;
  }
  const merged: unknown[] = [];
  const seenIds = new Set<string>();
  for (const call of input.incoming ?? []) {
    const record = toObjectRecord(call);
    const id = typeof record?.id === "string" ? record.id : null;
    if (!id) {
      merged.push(call);
      continue;
    }
    if (seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);
    const authoritative = authoritativeById.get(id);
    merged.push(
      authoritative
        ? applyCommittedArtifactToolCall(call, authoritative)
        : call,
    );
  }
  for (const [id, call] of authoritativeById) {
    if (seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);
    merged.push(call);
  }
  return merged;
}

export function hasPairedCommittedArtifactPublication(input: {
  toolCalls?: unknown[];
  renderBlocks?: unknown[];
  runId?: string;
}) {
  const blocksById = new Map<string, Record<string, unknown>>();
  for (const block of input.renderBlocks ?? []) {
    const id = getCommittedArtifactBlockId(block);
    const record = toObjectRecord(block);
    if (id && record && (!input.runId || record.threadRunId === input.runId)) {
      blocksById.set(id, record);
    }
  }
  return (input.toolCalls ?? []).some(
    (call) => getCommittedArtifactToolCall(call, blocksById) !== null,
  );
}
