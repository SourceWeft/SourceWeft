import { enqueueWithAudit, jobsQueue } from "../../../shared/queue";

/**
 * The AI overview job (`skill-overview-generate`) on the primary queue. One
 * job per skill version; the worker's handler is
 * `worker/processors/skill-overview-generate.ts`.
 */

export const SKILL_OVERVIEW_GENERATE_JOB = "skill-overview-generate";

// A few tries, spaced out: a gateway hiccup or a malformed answer is usually
// gone a minute later. After the last one the job stays failed, and its id
// keeps the scheduler from queueing the same content again (see below).
export const SKILL_OVERVIEW_JOB_ATTEMPTS = 3;
const SKILL_OVERVIEW_BACKOFF_MS = 60_000;

export type SkillOverviewGenerateJobPayload = {
  skillVersionId: string;
  // Not read by the processor — the row is the source of truth. They let the
  // job audit trail attribute the job.
  skillId: string;
  reason: "scheduled" | "regenerate";
  // The billing team/workspace at the time it was queued, for the audit
  // trail; the processor reads the setting afresh.
  teamId?: string;
  workspaceId?: string;
};

/**
 * The scheduled job's id: one per version, so the tick queueing the same
 * version twice is one job, and a version whose job failed for good is not
 * tried again until its content changes (a new version is a new id). A
 * completed job is removed at once, which lets a later tick queue the version
 * again if its rows were deleted.
 */
export function skillOverviewJobId(skillVersionId: string): string {
  return `${SKILL_OVERVIEW_GENERATE_JOB}_${skillVersionId}`;
}

export async function enqueueSkillOverviewJob(
  payload: SkillOverviewGenerateJobPayload,
  options: { jobId?: string } = {},
) {
  return enqueueWithAudit(SKILL_OVERVIEW_GENERATE_JOB, payload, {
    jobId: options.jobId ?? skillOverviewJobId(payload.skillVersionId),
    attempts: SKILL_OVERVIEW_JOB_ATTEMPTS,
    backoff: { type: "exponential", delay: SKILL_OVERVIEW_BACKOFF_MS },
    removeOnComplete: true,
    // Kept, so the id keeps blocking the same content; bounded all the same.
    removeOnFail: { count: 5_000 },
  });
}

/** Whether a job with this id is queued, running, delayed or failed. */
export async function skillOverviewJobExists(jobId: string): Promise<boolean> {
  const job = await jobsQueue.getJob(jobId);
  return Boolean(job);
}
