import { ContentError } from "../../content/errors";

/** Immutable for one invocation, including retries of that invocation. */
export type ReasoningRun = {
  readonly runId: string;
  readonly parentRunId: string | null;
  readonly base: string;
};

export type ReasoningWrite = ReasoningRun & {
  revision: number;
  terminal: boolean;
};

export function beginReasoningRun(input: {
  runId: string;
  continuation: boolean;
  metadata?: Record<string, unknown> | null;
  restored?: ReasoningRun;
}): ReasoningRun {
  if (input.restored) {
    if (input.restored.runId !== input.runId) throw invalidRun();
    return { ...input.restored };
  }
  const previous = input.metadata?.reasoningWrite as ReasoningWrite | undefined;
  if (previous?.runId === input.runId) {
    return {
      runId: previous.runId,
      parentRunId: previous.parentRunId,
      base: previous.base,
    };
  }
  return {
    runId: input.runId,
    parentRunId: previous?.runId ?? null,
    base:
      input.continuation && typeof input.metadata?.reasoning === "string"
        ? input.metadata.reasoning
        : "",
  };
}

export function projectReasoning(input: {
  run: ReasoningRun | undefined;
  text: string | undefined;
  revision?: number;
  terminal?: boolean;
}): { reasoning: string; reasoningWrite: ReasoningWrite } {
  if (!input.run) throw invalidRun();
  const text = input.text ?? "";
  const { base } = input.run;
  return {
    reasoning: base && text ? `${base}\n${text}` : base || text,
    reasoningWrite: {
      ...input.run,
      revision: input.terminal
        ? Number.MAX_SAFE_INTEGER
        : (input.revision ?? 0),
      terminal: input.terminal ?? false,
    },
  };
}

export function projectSnapshotReasoning(
  snapshot: {
    reasoningRun?: ReasoningRun;
    reasoning?: string;
    reasoningRevision?: number;
  },
  terminal = false,
): Record<string, unknown> {
  if (!snapshot.reasoningRun && snapshot.reasoning === undefined) return {};
  return projectReasoning({
    run: snapshot.reasoningRun,
    text: snapshot.reasoning,
    revision: snapshot.reasoningRevision,
    terminal,
  });
}

export function clientReasoningMetadata(metadata: Record<string, unknown>) {
  const { reasoningWrite: _reasoningWrite, ...clientMetadata } = metadata;
  return clientMetadata;
}

/** Called under the message row lock, before applying any part of a stale write. */
export function canApplyReasoningWrite(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): boolean {
  const previous = current.reasoningWrite as ReasoningWrite | undefined;
  const next = incoming.reasoningWrite as ReasoningWrite | undefined;
  if (!previous) return !next || next.parentRunId === null;
  if (!next) return incoming.reasoning === undefined;
  if (previous.runId !== next.runId) return next.parentRunId === previous.runId;
  if (
    previous.base !== next.base ||
    previous.parentRunId !== next.parentRunId
  ) {
    throw invalidRun();
  }
  if (previous.terminal && !next.terminal) return false;
  if (next.revision < previous.revision) return false;
  // Equal revisions must describe the same projection, including terminal retries.
  return (
    next.revision !== previous.revision ||
    incoming.reasoning === current.reasoning
  );
}

function invalidRun() {
  return new ContentError(
    409,
    "REASONING_RUN_CONFLICT",
    "Reasoning run state is missing or inconsistent",
  );
}
