import type { JobStatus } from "@sourceweft/contracts";

const terminalStatus: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "succeeded",
  "failed",
  "cancelled",
]);

export function isTerminalJobStatus(status: JobStatus) {
  return terminalStatus.has(status);
}

export function canCancelJob(status: JobStatus) {
  return status === "queued" || status === "running";
}
