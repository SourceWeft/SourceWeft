import { z } from "zod";

/** Public execution-stop metadata, independent of artifact delivery status. */
const legacyAgentRunStopSchema = z
  .object({
    reason: z.literal("step_limit"),
    steps: z.number().int().positive().safe(),
    limit: z.number().int().positive().safe(),
    canContinue: z.literal(true),
    summaryStatus: z.enum(["completed", "failed"]),
  })
  .strict()
  .refine((value) => value.steps === value.limit, {
    message: "A step-limit stop must match its execution limit",
    path: ["steps"],
  });

const positiveStep = z.number().int().positive().safe();
const stepCount = z.number().int().nonnegative().safe();
const segmentedBudgetFields = {
  policyVersion: z.literal(2),
  normalSteps: stepCount,
  normalLimit: positiveStep,
  closingSteps: stepCount,
  closingLimit: positiveStep,
  steps: stepCount,
  limit: positiveStep,
};

function coherentBudget(value: {
  normalSteps: number;
  normalLimit: number;
  closingSteps: number;
  closingLimit: number;
  steps: number;
  limit: number;
}) {
  return (
    Number.isSafeInteger(value.normalLimit + value.closingLimit) &&
    value.limit === value.normalLimit + value.closingLimit &&
    value.steps === value.normalSteps + value.closingSteps &&
    value.normalSteps <= value.normalLimit &&
    value.closingSteps <= value.closingLimit
  );
}

const segmentedAgentRunStopSchema = z
  .object({
    ...segmentedBudgetFields,
    reason: z.literal("step_limit"),
    canContinue: z.literal(true),
    summaryStatus: z.enum(["completed", "failed"]),
  })
  .strict()
  .refine(
    (value) =>
      coherentBudget(value) &&
      value.normalSteps === value.normalLimit &&
      value.closingSteps === value.closingLimit,
    {
      message: "A segmented stop must exhaust both coherent execution budgets",
    },
  );

/** Historical stops remain explicit; v2 never fills missing legacy counters. */
export const agentRunStopSchema = z.union([
  legacyAgentRunStopSchema,
  segmentedAgentRunStopSchema,
]);

export const agentRunProgressSchema = z
  .object({
    ...segmentedBudgetFields,
    phase: z.enum(["working", "closing", "finalizing"]),
  })
  .strict()
  .refine(
    (value) =>
      coherentBudget(value) &&
      (value.phase === "working"
        ? value.closingSteps === 0
        : value.phase === "closing"
          ? value.normalSteps === value.normalLimit
          : value.normalSteps === value.normalLimit &&
            value.closingSteps === value.closingLimit),
    { message: "Progress phase must match its coherent execution budgets" },
  );

export type AgentRunProgress = z.infer<typeof agentRunProgressSchema>;

export function readAgentRunProgress(value: unknown): AgentRunProgress | null {
  const parsed = agentRunProgressSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export type AgentRunStop = z.infer<typeof agentRunStopSchema>;

/** Reject malformed/private fields before projecting persisted metadata to UI. */
export function readAgentRunStop(value: unknown): AgentRunStop | null {
  const parsed = agentRunStopSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Accept only forward progress within the same snapshotted root budget. */
export function advanceAgentRunProgress(
  previous: unknown,
  next: unknown,
): AgentRunProgress | null {
  const incoming = readAgentRunProgress(next);
  const current = readAgentRunProgress(previous);
  if (!incoming) return current;
  if (!current) return incoming;
  const order = { working: 0, closing: 1, finalizing: 2 };
  return incoming.normalLimit === current.normalLimit &&
    incoming.closingLimit === current.closingLimit &&
    incoming.normalSteps >= current.normalSteps &&
    incoming.closingSteps >= current.closingSteps &&
    order[incoming.phase] >= order[current.phase]
    ? incoming
    : current;
}
