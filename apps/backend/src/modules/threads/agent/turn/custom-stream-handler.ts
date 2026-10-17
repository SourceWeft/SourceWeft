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
