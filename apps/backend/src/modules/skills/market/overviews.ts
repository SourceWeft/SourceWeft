import { config } from "../../../shared/config";
/**
 * AI-written overviews of public skills (skill-marketplace-plan §17.4).
 *
 * The scheduler calls `enqueueSkillOverviews` every tick. It queues a
 * generation job for public skills whose current version still has none — a
 * few per tick, so a large import is worked through over time rather than in
 * one burst; the job copies an identical earlier result instead of asking the
 * model again. Nothing happens while the system model the overviews are
 * written with is not ready. The tick itself is the catalog overview engine's
 * `enqueueOverviewBatch`.
 */
import { enqueueOverviewBatch } from "../../catalog-overview/jobs";
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
export const SKILL_OVERVIEW_BATCH_SIZE = config.market.skillOverviewBatchSize;
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

/**
 * Queues an overview for every public skill whose current version has none.
 * `copied` stays 0: cache reuse happens inside the versioned worker, never by
 * bundle alone.
 */
export async function enqueueSkillOverviews(
  deps: EnqueueSkillOverviewsDeps = defaultDeps,
): Promise<{ queued: number; copied: number; skipped: number }> {
  const { queued, skipped } = await enqueueOverviewBatch(
    {
      readModelReadiness: deps.readModelReadiness,
      recover: deps.recover,
      findCandidates: async (limit) =>
        (await deps.findCandidates(limit)).map((candidate) => ({
          versionId: candidate.skillVersionId,
          payload: {
            skillVersionId: candidate.skillVersionId,
            skillId: candidate.skillId,
            reason: "scheduled" as const,
          },
        })),
      jobExists: deps.jobExists,
      enqueue: deps.enqueue,
    },
    {
      jobId: skillOverviewJobId,
      batchSize: SKILL_OVERVIEW_BATCH_SIZE,
      scanLimit: SKILL_OVERVIEW_SCAN_LIMIT,
      label: "Skill",
    },
  );
  return { queued, copied: 0, skipped };
}
