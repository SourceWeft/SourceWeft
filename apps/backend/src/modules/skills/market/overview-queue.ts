import {
  createOverviewJobs,
  type OverviewJobPayload,
} from "../../catalog-overview/jobs";
import { skillOverviewStore } from "./overview-store";

/**
 * The AI overview job (`skill-overview-generate`) on the primary queue. One
 * job per skill version; the worker's handler is
 * `worker/processors/skill-overview-generate.ts`. Reservation, dedup ids,
 * retries and recovery are the catalog overview engine's (`jobs.ts`).
 */

export const SKILL_OVERVIEW_GENERATE_JOB = "skill-overview-generate";

// A few tries, spaced out: a gateway hiccup or a malformed answer is usually
// gone a minute later. After the last one the job stays failed, and its id
// keeps the scheduler from queueing the same content again (see below).
export const SKILL_OVERVIEW_JOB_ATTEMPTS = 3;
const SKILL_OVERVIEW_BACKOFF_MS = 60_000;

// `skillVersionId` is what the processor reads — the row is the source of
// truth. `skillId` lets the job audit trail attribute the job.
export type SkillOverviewGenerateJobPayload = OverviewJobPayload<
  "skillVersionId",
  "skillId"
>;

export const skillOverviewJobs = createOverviewJobs(
  {
    name: SKILL_OVERVIEW_GENERATE_JOB,
    versionKey: "skillVersionId",
    parentKey: "skillId",
    attempts: SKILL_OVERVIEW_JOB_ATTEMPTS,
    backoffMs: SKILL_OVERVIEW_BACKOFF_MS,
    scopePrefix: "skill-overview",
    label: "Skill",
  },
  skillOverviewStore,
);

/**
 * The scheduled job's id: one per version, so the tick queueing the same
 * version twice is one job, and a version whose job failed for good is not
 * tried again until its content changes (a new version is a new id). A
 * completed job is removed at once, which lets a later tick queue the version
 * again if its rows were deleted.
 */
export function skillOverviewJobId(skillVersionId: string): string {
  return skillOverviewJobs.jobId(skillVersionId);
}

export async function enqueueSkillOverviewJob(
  payload: SkillOverviewGenerateJobPayload,
  options: { jobId?: string } = {},
) {
  return skillOverviewJobs.enqueue(payload, options);
}

/** Whether a job with this id is queued, running, delayed or failed. */
export async function skillOverviewJobExists(jobId: string): Promise<boolean> {
  return skillOverviewJobs.exists(jobId);
}

/** Repair a crash between the durable reservation and Redis enqueue; failed jobs stay failed. */
export async function recoverSkillOverviewJobs() {
  return skillOverviewJobs.recover();
}
