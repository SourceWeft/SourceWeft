import type { ThinkingStepTrace } from "../../threads";
import { toObjectRecord } from "./content";

export function appendReasoningChunk(current: string | undefined, next: string) {
  if (!current) {
    return next;
  }
  if (next === current) {
    return current;
  }
  if (next.startsWith(current)) {
    return next;
  }
  return `${current}${next}`;
}

export function createModelReasoningSegmentId(input: {
  runTraceId: string;
  index: number;
}) {
  return `model-reasoning:${input.runTraceId}:${input.index}`;
}

export function extractReasoningSummaryFromProviderFields(
  providerFields: Record<string, unknown> | undefined,
) {
  if (!providerFields) {
    return null;
  }

  const candidates = [
    providerFields.reasoning_summary,
    providerFields.reasoningSummary,
    providerFields.reasoning,
    providerFields.summary,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }

    const record = toObjectRecord(candidate);
    if (record) {
      const text =
        typeof record.summary === "string"
          ? record.summary
          : typeof record.text === "string"
            ? record.text
            : typeof record.content === "string"
              ? record.content
              : null;
      if (text && text.trim().length > 0) {
        return text.trim();
      }
    }
  }

  return null;
}

export function upsertThinkingStep(input: {
  stepsById: Map<string, ThinkingStepTrace>;
  stepOrder: string[];
  step: ThinkingStepTrace;
}) {
  if (!input.stepsById.has(input.step.id)) {
    input.stepOrder.push(input.step.id);
  }
  input.stepsById.set(input.step.id, input.step);
  return input.step;
}

export function listThinkingSteps(input: {
  stepsById: Map<string, ThinkingStepTrace>;
  stepOrder: string[];
}) {
  return input.stepOrder
    .map((stepId) => input.stepsById.get(stepId))
    .filter((step): step is ThinkingStepTrace => Boolean(step));
}
