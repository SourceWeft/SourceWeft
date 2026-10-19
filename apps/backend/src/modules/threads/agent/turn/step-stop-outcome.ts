import type { AgentRunStop } from "@sourceweft/contracts";
import { ContentError } from "../../../content/errors";
import type { AgentCheckpointMetadata, AgentCheckpointRef } from "../..";
import type { RunCancellationGate } from "../../run-cancellation";
import {
  AgentStepSummaryError,
  agentStepBudgetContentError,
} from "../middleware/step-budget";
import type { TurnRuntime } from "./turn-runtime";

/** The middleware selects only the trusted current root scope's committed summary. */
export type VerifiedAgentStepStop = {
  agentRunStop: AgentRunStop;
  summaryText: string;
};

export function applyVerifiedAgentStepStop(
  runtime: TurnRuntime,
  selected: VerifiedAgentStepStop,
) {
  const summary = selected.summaryText.trim();
  if (selected.agentRunStop.summaryStatus !== "completed" || !summary) {
    throw new AgentStepSummaryError(selected.agentRunStop);
  }
  runtime.agentRunStop = selected.agentRunStop;
  runtime.stepLimitSummary = summary;
  runtime.assistantContent = summary;
  runtime.assistantContentFromUpdates = null;
  runtime.finishReason = "step_limit";
}

/** Cancellation still wins over a late successful summary or its failure. */
export async function assertAgentStepStopNotCancelled(input: {
  abortSignal?: AbortSignal;
  runCancellation?: RunCancellationGate;
}) {
  await input.runCancellation?.throwIfCancelled(
    "saving the step-limit summary",
  );
  if (input.abortSignal?.aborted) {
    throw new ContentError(499, "CLIENT_CANCELLED", "Chat run was cancelled");
  }
}

// Private failure recovery identity: never projected as public AgentRunStop.
const failureCheckpoints = new WeakMap<object, AgentCheckpointMetadata>();

function copyCheckpoint(
  value: AgentCheckpointMetadata,
): AgentCheckpointMetadata {
  return {
    beforeInput: value.beforeInput ? { ...value.beforeInput } : null,
    beforeAssistant: value.beforeAssistant
      ? { ...value.beforeAssistant }
      : null,
    resume: value.resume ? { ...value.resume } : null,
    final: value.final ? { ...value.final } : null,
  };
}

export function rememberAgentStepFailureCheckpoint(
  error: unknown,
  checkpoint: AgentCheckpointMetadata,
) {
  if (error && typeof error === "object") {
    failureCheckpoints.set(error, copyCheckpoint(checkpoint));
  }
}

/** Only runner-captured identities are trusted, never lookalike error fields. */
export function agentCheckpointFromStepStopError(
  error: unknown,
  seen = new Set<unknown>(),
): AgentCheckpointMetadata | null {
  if (!error || typeof error !== "object" || seen.has(error)) return null;
  seen.add(error);
  const checkpoint = failureCheckpoints.get(error);
  if (checkpoint) return copyCheckpoint(checkpoint);
  const record = error as { cause?: unknown; error?: unknown };
  return (
    agentCheckpointFromStepStopError(record.cause, seen) ??
    agentCheckpointFromStepStopError(record.error, seen)
  );
}

/** Unwrap the registered SDK failure before the stream boundary can normalize it. */
export async function captureAgentStepFailureCheckpoint(input: {
  error: unknown;
  readCurrentCheckpoint: () => Promise<AgentCheckpointRef | null>;
  beforeInput: AgentCheckpointRef | null;
  beforeAssistant: AgentCheckpointRef | null;
  abortSignal?: AbortSignal;
  runCancellation?: RunCancellationGate;
}): Promise<ContentError | null> {
  const failure = agentStepBudgetContentError(input.error);
  if (!failure) return null;
  await assertAgentStepStopNotCancelled(input);
  const final = await input.readCurrentCheckpoint();
  rememberAgentStepFailureCheckpoint(failure, {
    beforeInput: input.beforeInput,
    beforeAssistant: input.beforeAssistant,
    resume: null,
    final,
  });
  await assertAgentStepStopNotCancelled(input);
  return failure;
}
