import {
  readAgentRunStop,
  advanceAgentRunProgress,
} from "@sourceweft/contracts";

/** Omitted terminal fields preserve an earlier error marker; explicit null clears it. */
export function agentRunStopMetadata(value: unknown, cancelled = false) {
  if (cancelled) return { agentRunStop: null };
  return value === undefined ? {} : { agentRunStop: readAgentRunStop(value) };
}

/** Missing fields preserve a checkpoint snapshot; explicit null/cancel clear it. */
export function agentRunProgressMetadata(
  value: unknown,
  previous?: unknown,
  cancelled = false,
) {
  if (cancelled || value === null) return { agentRunProgress: null };
  return value === undefined
    ? {}
    : { agentRunProgress: advanceAgentRunProgress(previous, value) };
}
