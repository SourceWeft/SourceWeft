import { advanceAgentRunProgress } from "@sourceweft/contracts";
import { toObjectRecord } from "../../../../shared/records";
import type { DeepAgentTurnEvent } from "./events";
import {
  buildGeneratedArtifactProgressToolCallEvent,
  buildPresentationProgressThinkingEvent,
  normalizeGeneratedImageProgressEvent,
  normalizeGeneratedPresentationProgressEvent,
} from "./progress-events";
import type { TurnRuntime } from "./turn-runtime";
import {
  MODEL_CALL_BEGIN_CUSTOM_EVENT,
  MODEL_CALL_RETRY_CUSTOM_EVENT,
} from "../middleware/model-call-observability";

export async function* handleCustomStreamChunk(input: {
  payload: unknown;
  runtime: TurnRuntime;
}): AsyncGenerator<DeepAgentTurnEvent> {
  const { payload, runtime } = input;
  const record = toObjectRecord(payload);
  if (record?.type === "agent-run-progress") {
    const next = advanceAgentRunProgress(
      runtime.agentRunProgress,
      record.progress,
    );
    if (
      next &&
      JSON.stringify(next) !== JSON.stringify(runtime.agentRunProgress)
    ) {
      runtime.agentRunProgress = next;
      yield { type: "agent-run-progress", progress: next };
    }
    return;
  }
  if (record?.type === MODEL_CALL_BEGIN_CUSTOM_EVENT) {
    // Every attempt (first or retried) re-marks the boundary: what the runtime
    // holds now is what survives if this attempt dies mid-stream. Any segment
    // still open (a model re-entry without a tool boundary, e.g. the step
    // budget's `jumpTo: "model"`) is closed first, so everything the attempt
    // streams lands in segments of its own and a reset can name them by id.
    runtime.resetReasoningBoundary();
    // Streamed tool-arg slots are keyed by block index, which every model call
    // restarts at 0, so a slot left by an earlier call would absorb this one's
    // chunks. They are dropped here, before the boundary is captured: an
    // earlier successful call's tool calls have been promoted by the `tools`
    // method by now, and a retried attempt's predecessor was already withdrawn
    // by `model-call-retry`, so nothing still owed to the client is lost, and
    // every slot after this point belongs to this attempt (which is what lets a
    // `segment-reset` name its call ids). Not the v3 `message-finish` event:
    // it fires once the provider stream ends, before middleware inside the
    // attempt can still fail it, and it also fires for non-model node output.
    runtime.partialToolArgsBySlot.clear();
    runtime.modelCallBoundary = runtime.captureModelCallBoundary(
      readAttempt(record.attempt),
    );
    return;
  }
  if (record?.type === MODEL_CALL_RETRY_CUSTOM_EVENT) {
    const boundary = runtime.modelCallBoundary;
    if (!boundary) {
      // No attempt was announced, so nothing is attributable to one; the
      // retried attempt simply streams on (the pre-reset behaviour).
      return;
    }
    const discarded = runtime.discardModelOutputSince(boundary);
    runtime.resetReasoningBoundary();
    runtime.modelCallBoundary = null;
    yield {
      type: "segment-reset",
      reason: "model_call_retry",
      attempt: readAttempt(record.attempt, boundary.attempt + 1),
      ...discarded,
    };
    return;
  }
  const progressEvent =
    normalizeGeneratedImageProgressEvent(payload) ??
    normalizeGeneratedPresentationProgressEvent(payload);
  if (!progressEvent) {
    return;
  }

  const toolCallEvent = buildGeneratedArtifactProgressToolCallEvent({
    progressEvent,
    toolCallsById: runtime.toolCallsById,
  });
  if (!toolCallEvent) {
    return;
  }

  yield toolCallEvent;
  const progressThinkingEvent = buildPresentationProgressThinkingEvent({
    progressEvent,
    setThinkingStep: runtime.setThinkingStep,
  });
  if (progressThinkingEvent) {
    yield progressThinkingEvent;
  }
}

function readAttempt(value: unknown, fallback = 1) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1
    ? value
    : fallback;
}
