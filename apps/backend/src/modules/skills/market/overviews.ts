/**
 * AI-written overviews of public skills (skill-marketplace-plan §17.4).
 *
 * The scheduler calls `enqueueSkillOverviews` every tick. It copies overviews
 * over wherever the same content already has one, then queues a generation
 * job for public skills whose current version still has none — a few per
 * tick, so a large import is worked through over time rather than in one
 * burst. Nothing happens until a market admin has said who pays
 * (`overview.billing`).
 */
import { logger } from "../../../shared/logger";
import {
  enqueueSkillOverviewJob,
  skillOverviewJobExists,
  skillOverviewJobId,
  type SkillOverviewGenerateJobPayload,
} from "./overview-queue";
import {
  copySkillOverviewsForAllSameBundles,
  findSkillOverviewCandidates,
  readSkillOverviewBilling,
  type SkillOverviewBillingTarget,
  type SkillOverviewCandidate,
} from "./overview-repository";

// Jobs queued per tick.
export const SKILL_OVERVIEW_BATCH_SIZE = 20;
// Candidates looked at per tick. More than the batch: some already have a job
// (queued, retrying, or failed for good) and are passed over.
const SKILL_OVERVIEW_SCAN_LIMIT = 1_000;

export type EnqueueSkillOverviewsDeps = {
  readBilling: () => Promise<SkillOverviewBillingTarget | null>;
  copyFromSameBundles: () => Promise<number>;
  findCandidates: (limit: number) => Promise<SkillOverviewCandidate[]>;
  jobExists: (jobId: string) => Promise<boolean>;
  enqueue: (payload: SkillOverviewGenerateJobPayload) => Promise<unknown>;
};

const defaultDeps: EnqueueSkillOverviewsDeps = {
  readBilling: async () => (await readSkillOverviewBilling()).billing,
  copyFromSameBundles: () => copySkillOverviewsForAllSameBundles(),
  findCandidates: (limit) => findSkillOverviewCandidates({ limit }),
  jobExists: skillOverviewJobExists,
  enqueue: (payload) => enqueueSkillOverviewJob(payload),
};

/** Queues an overview for every public skill whose current version has none. */
export async function enqueueSkillOverviews(
  deps: EnqueueSkillOverviewsDeps = defaultDeps,
): Promise<{ queued: number; copied: number; skipped: number }> {
  const billing = await deps.readBilling();
  if (!billing) {
    logger.debug(
      "Skill overviews not queued: no billing team is set (overview.billing)",
    );
    return { queued: 0, copied: 0, skipped: 0 };
  }
  // Identical content first: free, and it takes those versions off the list.
  const copied = await deps.copyFromSameBundles();
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
      teamId: billing.teamId,
      workspaceId: billing.workspaceId,
    });
    queued += 1;
  }
  if (queued > 0 || copied > 0) {
    logger.info("Skill overviews queued", { queued, copied, skipped });
  }
  return { queued, copied, skipped };
}
