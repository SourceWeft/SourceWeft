import type { ThinkingStepTrace } from "../../threads";

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
