import { enqueueWithAudit, jobsQueue } from "../../../shared/queue";

/**
 * The summary translation job (`mcp-summary-translation`) on the primary
 * queue. The scheduler only queues it — the system model's key is given to
 * the api and worker services, not to the scheduler — and the worker runs a
 * pass (`worker/processors/mcp-summary-translation.ts`).
 *
 * One job at a time: while one is queued or running, the next tick queues
 * nothing, so passes never pile up behind a stopped worker.
 */

export const MCP_SUMMARY_TRANSLATION_JOB = "mcp-summary-translation";
export const MCP_SUMMARY_TRANSLATION_SCHEDULED_JOB_ID = `${MCP_SUMMARY_TRANSLATION_JOB}_scheduled`;

/** Queue a pass unless one is already waiting or running; true when queued. */
export async function enqueueMcpSummaryTranslation(): Promise<boolean> {
  if (await jobsQueue.getJob(MCP_SUMMARY_TRANSLATION_SCHEDULED_JOB_ID)) {
    return false;
  }
  await enqueueWithAudit(
    MCP_SUMMARY_TRANSLATION_JOB,
    {},
    {
      jobId: MCP_SUMMARY_TRANSLATION_SCHEDULED_JOB_ID,
      // The next tick is the retry: what a failed pass left is still due.
      attempts: 1,
      // Gone once done either way, so the id is free for the next pass.
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
  return true;
}
