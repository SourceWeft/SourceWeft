import { toolConfirmationRequestSchema } from "@sourceweft/contracts";
import { toObjectRecord } from "../../../shared/records";
/** A parked run is not a completed run. The final frame must preserve its
 * reason and confirmations so live clients do not clear their approval state. */
export function approvalFinishPayload(input: {
  snapshot: Record<string, unknown>;
  assistantMessageId: string | null;
  userMessageId?: string | null;
}) {
  const calls = Array.isArray(input.snapshot.toolCalls)
    ? input.snapshot.toolCalls
    : [];
  const liveConfirmations = calls.flatMap((value) => {
    const call = toObjectRecord(value);
    if (call?.status !== "approval_requested") return [];
    const parsed = toolConfirmationRequestSchema.safeParse(call.output);
    return parsed.success
      ? [{ toolCall: call, confirmation: parsed.data }]
      : [];
  });
  return {
    type: "finish",
    finishReason: input.snapshot.finishReason ?? "tool_confirmation_requested",
    messageId: input.assistantMessageId,
    userMessageId: input.userMessageId ?? null,
    liveConfirmations,
  };
}
