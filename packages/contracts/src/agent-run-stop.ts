import { z } from "zod";

/** Public execution-stop metadata, independent of artifact delivery status. */
export const agentRunStopSchema = z
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

export type AgentRunStop = z.infer<typeof agentRunStopSchema>;

/** Reject malformed/private fields before projecting persisted metadata to UI. */
export function readAgentRunStop(value: unknown): AgentRunStop | null {
  const parsed = agentRunStopSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
