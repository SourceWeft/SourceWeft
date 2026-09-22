import {
  requestSkillAnalysis,
  failSkillAnalysis,
  readSkillAnalysis,
  findInterruptedSkillAnalyses,
} from "./analysis-repository";
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
  requestId?: string;
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
  const state = payload.requestId
    ? await readSkillAnalysis(payload.skillVersionId)
    : await requestSkillAnalysis(
        payload.skillVersionId,
        payload.reason === "regenerate",
      );
  if (
    !state ||
    (payload.requestId &&
      (state.requestId !== payload.requestId ||
        !["pending", "running"].includes(state.status)))
  )
    return null;
  try {
    return await enqueueWithAudit(
      SKILL_OVERVIEW_GENERATE_JOB,
      { ...payload, requestId: state.requestId },
      {
        jobId:
          options.jobId ??
          `${skillOverviewJobId(payload.skillVersionId)}_${state.requestId}`,
        attempts: SKILL_OVERVIEW_JOB_ATTEMPTS,
        backoff: { type: "exponential", delay: SKILL_OVERVIEW_BACKOFF_MS },
        removeOnComplete: true,
        removeOnFail: { count: 5_000 },
      },
    );
  } catch (error) {
    await failSkillAnalysis(
      payload.skillVersionId,
      state.requestId,
      "Could not queue analysis; retry from administration",
      false,
    );
    throw error;
  }
}

/** Whether a job with this id is queued, running, delayed or failed. */
export async function skillOverviewJobExists(jobId: string): Promise<boolean> {
  const job = await jobsQueue.getJob(jobId);
  return Boolean(job);
}

/** Repair a crash between the durable reservation and Redis enqueue; failed jobs stay failed. */
export async function recoverSkillOverviewJobs() {
  let recovered = 0;
  for (const state of await findInterruptedSkillAnalyses()) {
    const jobId = `${skillOverviewJobId(state.skillVersionId)}_${state.requestId}`;
    const job = await jobsQueue.getJob(jobId);
    if (job) {
      if ((await job.getState()) === "failed")
        await failSkillAnalysis(
          state.skillVersionId,
          state.requestId,
          "Worker job failed; retry from administration",
          false,
        );
      continue;
    }
    const result = await enqueueSkillOverviewJob({
      skillVersionId: state.skillVersionId,
      skillId: state.skillId,
      requestId: state.requestId,
      reason: state.force ? "regenerate" : "scheduled",
    });
    if (result) recovered++;
  }
  return recovered;
}
