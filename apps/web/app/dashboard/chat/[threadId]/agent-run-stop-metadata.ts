import { readAgentRunStop } from "@sourceweft/contracts";

/** Omitted terminal fields preserve an earlier error marker; explicit null clears it. */
export function agentRunStopMetadata(value: unknown, cancelled = false) {
  if (cancelled) return { agentRunStop: null };
  return value === undefined ? {} : { agentRunStop: readAgentRunStop(value) };
}
