import type { ThinkingStepTrace, ToolCallTrace } from "./types";
import {
  normalizeTraceParts,
  tracePartFromThinkingStep,
  upsertTracePart,
  type TracePart,
} from "./trace-parts";

export type AssistantTerminalMode = "success" | "error";

export function terminalizeThinkingStep(
  step: ThinkingStepTrace,
): ThinkingStepTrace {
  if (step.status !== "in_progress") {
    return step;
  }
  return {
    ...step,
    status: "completed",
  };
}

export function terminalizeToolCall(input: {
  errorMessage?: string;
  mode: AssistantTerminalMode;
  toolCall: ToolCallTrace;
}): ToolCallTrace {
  if (input.toolCall.status !== "running") {
    return input.toolCall;
  }
  if (input.mode === "error") {
    return {
      ...input.toolCall,
      status: "error",
      error:
        input.toolCall.error ?? input.errorMessage ?? "Tool execution failed.",
    };
  }
  return {
    ...input.toolCall,
    status: "completed",
  };
}

export function terminalizeTracePart(input: {
  errorMessage?: string;
  mode: AssistantTerminalMode;
  part: TracePart;
}): TracePart {
  if (input.part.kind === "step" && input.part.status === "in_progress") {
    return {
      ...input.part,
      status: "completed",
    };
  }
  if (input.part.kind === "tool" && input.part.status === "running") {
    if (input.mode === "error") {
      return {
        ...input.part,
        status: "error",
        error:
          input.part.error ?? input.errorMessage ?? "Tool execution failed.",
      };
    }
    return {
      ...input.part,
      status: "completed",
    };
  }
  return input.part;
}

export function terminalizeTraceParts(input: {
  errorMessage?: string;
  mode: AssistantTerminalMode;
  traceParts: unknown;
}) {
  return normalizeTraceParts(input.traceParts).map((part) =>
    terminalizeTracePart({
      errorMessage: input.errorMessage,
      mode: input.mode,
      part,
    }),
  );
}

export function mergeThinkingSteps(input: {
  preflightSteps?: ThinkingStepTrace[];
  runtimeSteps?: ThinkingStepTrace[];
}) {
  const stepsById = new Map<string, ThinkingStepTrace>();
  for (const step of input.preflightSteps ?? []) {
    stepsById.set(step.id, step);
  }
  for (const step of input.runtimeSteps ?? []) {
    const existing = stepsById.get(step.id);
    if (!existing || step.kind !== "log") {
      stepsById.set(step.id, step);
      continue;
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
  return [...stepsById.values()].sort(
    (left, right) => (left.sequence ?? 0) - (right.sequence ?? 0),
  );
}

export function buildTerminalAssistantTraceState(input: {
  errorMessage?: string;
  mode: AssistantTerminalMode;
  preflightThinkingSteps?: ThinkingStepTrace[];
  runtimeThinkingSteps?: ThinkingStepTrace[];
  traceParts: unknown;
}) {
  const thinkingSteps = mergeThinkingSteps({
    preflightSteps: input.preflightThinkingSteps,
    runtimeSteps: input.runtimeThinkingSteps,
  }).map(terminalizeThinkingStep);
  const tracePartsWithSteps = thinkingSteps.reduce(
    (parts, step) => upsertTracePart(parts, tracePartFromThinkingStep(step)),
    normalizeTraceParts(input.traceParts),
  );

  return {
    thinkingSteps,
    traceParts: terminalizeTraceParts({
      errorMessage: input.errorMessage,
      mode: input.mode,
      traceParts: tracePartsWithSteps,
    }),
  };
}
