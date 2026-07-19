import { logger } from "../../shared/logger";

/**
 * Boundary cleanup for deliverable jobs that die OUTSIDE the processor —
 * stalled jobs (worker restart/crash mid-run) and other BullMQ-level
 * failures never reach the host's catch block, which would otherwise leave
 * the artifact in "running" forever with no job behind it.
 *
 * Marking is idempotent and never clobbers a terminal state: markFailed is
 * called with expectedStatuses ["pending", "running"], so artifacts the
 * processor already marked failed/ready are untouched.
 */
export const DELIVERABLE_JOB_FAILED_CODE = "DELIVERABLE_JOB_FAILED";

export type DeliverableJobFailureInput = {
  jobName: string;
  attemptsMade: number;
  maxAttempts: number;
  data: Record<string, unknown>;
  error: Error;
  failureCodes: Record<string, string>;
  markFailed: (input: {
    artifactId: string;
    teamId?: string;
    workspaceId?: string;
    expectedStatuses?: Array<"pending" | "running" | "ready" | "failed">;
    errorCode: string;
    errorMessage: string;
  }) => Promise<unknown>;
};

export async function handleDeliverableJobFailure(
  input: DeliverableJobFailureInput,
): Promise<"marked" | "skipped"> {
  if (input.attemptsMade < input.maxAttempts) {
    return "skipped";
  }
  const artifactId =
    typeof input.data.artifactId === "string" ? input.data.artifactId : null;
  if (!artifactId) {
    return "skipped";
  }
  const errorCode =
    input.failureCodes[input.jobName] ?? DELIVERABLE_JOB_FAILED_CODE;
  const errorMessage = input.error.message || "Deliverable job failed";
  try {
    await input.markFailed({
      artifactId,
      teamId:
        typeof input.data.teamId === "string" ? input.data.teamId : undefined,
      workspaceId:
        typeof input.data.workspaceId === "string"
          ? input.data.workspaceId
          : undefined,
      expectedStatuses: ["pending", "running"],
      errorCode,
      errorMessage,
    });
    logger.warn("deliverable_job_failure_boundary_marked", {
      jobName: input.jobName,
      artifactId,
      errorCode,
      errorMessage,
    });
    return "marked";
  } catch (error) {
    logger.error("deliverable_job_failure_boundary_error", {
      jobName: input.jobName,
      artifactId,
      error: error instanceof Error ? error.message : String(error),
    });
    return "skipped";
  }
}
