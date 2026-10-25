import { enqueueWithAudit, jobsQueue } from "../../../shared/queue";
import { getSystemModelReadiness } from "../../../shared/model-gateway/system-client";

/**
 * The summary translation job (`mcp-summary-translation`) on the primary
 * queue. The scheduler only queues it, and only while the system model is
 * ready; the worker runs a pass
 * (`worker/processors/mcp-summary-translation.ts`).
 *
 * One job at a time: while one is queued or running, the next tick queues
 * nothing, so passes never pile up behind a stopped worker.
 */

export const MCP_SUMMARY_TRANSLATION_JOB = "mcp-summary-translation";
export const MCP_SUMMARY_TRANSLATION_SCHEDULED_JOB_ID = `${MCP_SUMMARY_TRANSLATION_JOB}_scheduled`;

export type EnqueueMcpSummaryTranslationDeps = {
  modelReady: () => Promise<boolean>;
  jobExists: (jobId: string) => Promise<boolean>;
  enqueue: (jobId: string) => Promise<unknown>;
};

const defaultDeps: EnqueueMcpSummaryTranslationDeps = {
  modelReady: async () => (await getSystemModelReadiness()).ready,
  jobExists: async (jobId) => Boolean(await jobsQueue.getJob(jobId)),
  enqueue: (jobId) =>
    enqueueWithAudit(
      MCP_SUMMARY_TRANSLATION_JOB,
      {},
      {
        jobId,
        // The next tick is the retry: what a failed pass left is still due.
        attempts: 1,
        // Gone once done either way, so the id is free for the next pass.
        removeOnComplete: true,
        removeOnFail: true,
      },
    ),
};

/**
 * Queue a pass unless the system model is not ready or one is already
 * waiting or running; true when queued.
 */
export async function enqueueMcpSummaryTranslation(
  deps: EnqueueMcpSummaryTranslationDeps = defaultDeps,
): Promise<boolean> {
  if (!(await deps.modelReady())) return false;
  if (await deps.jobExists(MCP_SUMMARY_TRANSLATION_SCHEDULED_JOB_ID)) {
    return false;
  }
  await deps.enqueue(MCP_SUMMARY_TRANSLATION_SCHEDULED_JOB_ID);
  return true;
}
