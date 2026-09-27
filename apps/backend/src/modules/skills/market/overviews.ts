/**
 * AI-written overviews of public skills (skill-marketplace-plan §17.4).
 *
 * The scheduler calls `enqueueSkillOverviews` every tick. It copies overviews
 * over wherever the same content already has one, then queues a generation
 * job for public skills whose current version still has none — a few per
 * tick, so a large import is worked through over time rather than in one
 * burst. Nothing happens while the system model the overviews are written
 * with is not ready.
 */
import { logger } from "../../../shared/logger";
import {
  getSystemModelReadiness,
  type SystemModelReadiness,
} from "../../../shared/model-gateway/system-client";
import {
  enqueueSkillOverviewJob,
  recoverSkillOverviewJobs,
  skillOverviewJobExists,
  skillOverviewJobId,
  type SkillOverviewGenerateJobPayload,
} from "./overview-queue";
import {
  findSkillOverviewCandidates,
  type SkillOverviewCandidate,
} from "./overview-repository";

// Jobs queued per tick.
export const SKILL_OVERVIEW_BATCH_SIZE = 20;
// Candidates looked at per tick. More than the batch: some already have a job
// (queued, retrying, or failed for good) and are passed over.
const SKILL_OVERVIEW_SCAN_LIMIT = 1_000;

export type EnqueueSkillOverviewsDeps = {
  readModelReadiness: () => Promise<
    Pick<SystemModelReadiness, "ready" | "reason">
  >;
  findCandidates: (limit: number) => Promise<SkillOverviewCandidate[]>;
  jobExists: (jobId: string) => Promise<boolean>;
  recover?: () => Promise<number>;
  enqueue: (payload: SkillOverviewGenerateJobPayload) => Promise<unknown>;
};

const defaultDeps: EnqueueSkillOverviewsDeps = {
  recover: recoverSkillOverviewJobs,
  readModelReadiness: getSystemModelReadiness,
  findCandidates: (limit) => findSkillOverviewCandidates({ limit }),
  jobExists: skillOverviewJobExists,
  enqueue: (payload) => enqueueSkillOverviewJob(payload),
};

/** Queues an overview for every public skill whose current version has none. */
export async function enqueueSkillOverviews(
  deps: EnqueueSkillOverviewsDeps = defaultDeps,
): Promise<{ queued: number; copied: number; skipped: number }> {
  const readiness = await deps.readModelReadiness();
  if (!readiness.ready) {
    logger.debug("Skill overviews not queued: the system model is not ready", {
      reason: readiness.reason,
    });
    return { queued: 0, copied: 0, skipped: 0 };
  }
  await deps.recover?.();
  // Identical content first: free, and it takes those versions off the list.
  const copied = 0; // Cache reuse happens inside the versioned worker, never by bundle alone.
  const candidates = await deps.findCandidates(SKILL_OVERVIEW_SCAN_LIMIT);
  let queued = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    if (queued >= SKILL_OVERVIEW_BATCH_SIZE) break;
    // A job already there is in progress, waiting to retry, or failed for
    // good — which stands until the content (and so the version) changes.
    if (await deps.jobExists(skillOverviewJobId(candidate.skillVersionId))) {
      skipped += 1;
      continue;
    }
    await deps.enqueue({
      skillVersionId: candidate.skillVersionId,
      skillId: candidate.skillId,
      reason: "scheduled",
    });
    queued += 1;
  }
  if (queued > 0 || copied > 0) {
    logger.info("Skill overviews queued", { queued, copied, skipped });
  }
  return { queued, copied, skipped };
}
