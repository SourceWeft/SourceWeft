/**
 * State accumulated over one streaming thread run — tool calls, thinking
 * steps, reasoning segments, trace parts — and its terminal projections:
 * the partial state persisted on failure, the terminal trace state on
 * success, and the tool-confirmation payload of the `finish` event.
 *
 * Carved out of `service.ts` verbatim (T2.3 mechanical split); behavior
 * unchanged.
 */
import {
  isPendingToolConfirmation,
  toolConfirmationRequestSchema,
} from "@sourceweft/contracts";
import { ContentError } from "../../content/errors";
import type { DeepAgentTurnOutcome } from "../agent/turn/runner";
import { DEEPAGENTS_WRITE_TODOS_TOOL_NAME } from "../agent/turn/tool-tracker";
import type { AgentCitation } from "../agent/citation-registry";
import type {
  MessageRenderBlock,
  MeteredLlmCallTrace,
  ModelReasoningSegmentTrace,
  ThinkingStepTrace,
  ToolCallTrace,
} from "../turn/types";
import type { TracePart } from "../turn/trace-parts";
import {
  buildTerminalAssistantTraceState,
  terminalizeToolCall,
} from "../turn/assistant-run-terminal-state";
import type { ThreadStreamPartialErrorState } from "./error";

export function resolveToolConfirmationFinishPayload(
  outcome: DeepAgentTurnOutcome,
) {
  if (outcome.finishReason !== "tool_confirmation_requested") {
    return {};
  }

  const liveConfirmations = outcome.toolCalls
    .map((toolCall) => {
      const confirmation = toolConfirmationRequestSchema.safeParse(
        toolCall.output,
      );
      if (
        !confirmation.success ||
        !isPendingToolConfirmation(confirmation.data)
      ) {
        return null;
      }
      return {
        confirmation: confirmation.data,
        toolCall,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  if (liveConfirmations.length === 0) {
    throw new ContentError(
      500,
      "TOOL_CONFIRMATION_PAYLOAD_MISSING",
      "Tool confirmation finish is missing confirmation payload.",
    );
  }

  return { liveConfirmations };
}

function isVisibleTracePart(part: TracePart) {
  return part.kind !== "tool" || part.tool !== DEEPAGENTS_WRITE_TODOS_TOOL_NAME;
}

export function upsertToolCallTrace(
  callsById: Map<string, ToolCallTrace>,
  toolCall: ToolCallTrace,
) {
  const existing = callsById.get(toolCall.id);
  const approvalState = toolCall.approvalState ?? existing?.approvalState;
  const approvalConfirmationId =
    toolCall.approvalConfirmationId ?? existing?.approvalConfirmationId;
  callsById.set(toolCall.id, {
    ...(existing ?? {}),
    ...toolCall,
    ...(approvalState ? { approvalState } : {}),
    ...(approvalConfirmationId ? { approvalConfirmationId } : {}),
  });
}

export function upsertThinkingStepTrace(
  stepsById: Map<string, ThinkingStepTrace>,
  step: ThinkingStepTrace,
) {
  const existing = stepsById.get(step.id);
  if (!existing || step.kind !== "log") {
    stepsById.set(step.id, step);
    return;
  }

  stepsById.set(step.id, {
    ...existing,
    status: step.status,
    description: step.description ?? existing.description,
    detail: step.detail ?? existing.detail,
    items: step.items.length > 0 ? step.items : existing.items,
    metadata: {
      ...(existing.metadata ?? {}),
      ...(step.metadata ?? {}),
    },
  });
}

export function getThinkingStepStreamKey(step: ThinkingStepTrace) {
  return `${step.id}:${step.status}:${step.title}`;
}

// The agent turn runtime owns the reasoning delta-vs-snapshot reconciliation;
// re-exported (through the agent subdomain's index door) instead of keeping a
// second copy that could drift from the one the message stream applies.
export { appendReasoningChunk } from "../agent";

function isSameReasoningSegment(
  existing: ModelReasoningSegmentTrace | undefined,
  next: ModelReasoningSegmentTrace,
) {
  return (
    existing?.id === next.id &&
    typeof existing.text === "string" &&
    typeof next.text === "string"
  );
}

export function upsertReasoningSegmentTrace(
  segmentsById: Map<string, ModelReasoningSegmentTrace>,
  next: ModelReasoningSegmentTrace,
) {
  if (isSameReasoningSegment(segmentsById.get(next.id), next)) {
    const existing = segmentsById.get(next.id);
    segmentsById.set(next.id, {
      ...(existing ?? next),
      ...next,
      id: next.id,
      sequence: existing?.sequence ?? next.sequence,
    });
    return;
  }

  if (!segmentsById.has(next.id)) {
    segmentsById.set(next.id, next);
    return;
  }

  let suffix = 2;
  let nextId = `${next.id}:${suffix}`;
  while (segmentsById.has(nextId)) {
    suffix += 1;
    nextId = `${next.id}:${suffix}`;
  }
  segmentsById.set(nextId, {
    ...next,
    id: nextId,
  });
}

export function buildPartialErrorState(input: {
  errorMessage?: string;
  preflightThinkingSteps?: ThinkingStepTrace[];
  reasoning?: string;
  reasoningSegmentsById: Map<string, ModelReasoningSegmentTrace>;
  traceParts: TracePart[];
  toolCallsById: Map<string, ToolCallTrace>;
  thinkingStepsById: Map<string, ThinkingStepTrace>;
  renderBlocks?: MessageRenderBlock[];
  citations: AgentCitation[];
  availableCitations: AgentCitation[];
  meteredLlmCalls: MeteredLlmCallTrace[];
}): ThreadStreamPartialErrorState {
  const terminalTraceState = buildTerminalAssistantTraceState({
    errorMessage: input.errorMessage,
    mode: "error",
    preflightThinkingSteps: input.preflightThinkingSteps ?? [],
    runtimeThinkingSteps: [...input.thinkingStepsById.values()],
    traceParts: input.traceParts,
  });
  return {
    reasoning: input.reasoning,
    reasoningSegments: [...input.reasoningSegmentsById.values()],
    traceParts: terminalTraceState.traceParts.filter(isVisibleTracePart),
    toolCalls: [...input.toolCallsById.values()].map((toolCall) =>
      terminalizeToolCall({
        errorMessage: input.errorMessage,
        mode: "error",
        toolCall,
      }),
    ),
    thinkingSteps: terminalTraceState.thinkingSteps,
    renderBlocks: input.renderBlocks,
    citations: input.citations,
    availableCitations: input.availableCitations,
    meteredLlmCalls: input.meteredLlmCalls,
  };
}

export function buildTerminalTraceState(input: {
  preflightThinkingSteps: ThinkingStepTrace[];
  runtimeThinkingSteps: ThinkingStepTrace[];
  traceParts: TracePart[];
}) {
  const terminalTraceState = buildTerminalAssistantTraceState({
    mode: "success",
    preflightThinkingSteps: input.preflightThinkingSteps,
    runtimeThinkingSteps: input.runtimeThinkingSteps,
    traceParts: input.traceParts,
  });
  return {
    thinkingSteps: terminalTraceState.thinkingSteps,
    traceParts: terminalTraceState.traceParts.filter(isVisibleTracePart),
  };
}
