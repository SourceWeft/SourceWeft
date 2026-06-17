import type {
  MessageRenderBlock,
  ThinkingStepRecord,
  ToolCallRecord,
} from "../_components/chat-canvas";

export type AssistantLifecycle =
  | "idle"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "cancelled";

export function resolveFinishedThreadRunStatus(input: {
  existingStatus: string | null;
  finishReason?: string | null;
}) {
  if (
    input.existingStatus === "failed" ||
    input.existingStatus === "cancelled"
  ) {
    return input.existingStatus;
  }
  if (input.finishReason === "tool_confirmation_requested") {
    return "waiting_for_approval";
  }
  return "completed";
}

function completeRunningToolCall(toolCall: ToolCallRecord): ToolCallRecord {
  if (toolCall.status !== "running") {
    return toolCall;
  }
  return {
    ...toolCall,
    status: "completed",
  };
}

function completeRunningThinkingStep(
  step: ThinkingStepRecord,
): ThinkingStepRecord {
  if (step.status !== "in_progress") {
    return step;
  }
  return {
    ...step,
    status: "completed",
  };
}

export function finishStreamingAssistantRun(input: {
  durableRunKey: string;
  existingRun: Record<string, unknown> | null;
  existingStatus: string | null;
  finishReason?: string | null;
  mode: "send" | "refresh" | "edit" | "resume";
  renderBlocks: MessageRenderBlock[];
  thinkingSteps: ThinkingStepRecord[];
  toolCalls: ToolCallRecord[];
}) {
  const nextStatus = resolveFinishedThreadRunStatus({
    existingStatus: input.existingStatus,
    finishReason: input.finishReason,
  });
  const terminalFinishReason =
    input.finishReason ?? (nextStatus === "completed" ? "stop" : null);

  return {
    metadata: {
      ...(terminalFinishReason ? { finishReason: terminalFinishReason } : {}),
      renderBlocks: input.renderBlocks,
      thinkingSteps: input.thinkingSteps.map(completeRunningThinkingStep),
      toolCalls: input.toolCalls.map(completeRunningToolCall),
      threadRun: {
        ...(input.existingRun ?? {}),
        idempotencyKey: input.durableRunKey,
        status: nextStatus,
        mode: input.mode,
      },
    },
    status: nextStatus,
  };
}
