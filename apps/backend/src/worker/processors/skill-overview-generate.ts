import type { Job } from "bullmq";
import { resolveSkillAnalysisModelKey } from "../../modules/skills/market/analysis-model";
import {
  createSkillOverviewModelCall,
  generateSkillOverview,
  type GenerateSkillOverviewResult,
} from "../../modules/skills/market/overview-generate";
import { skillOverviewJobs } from "../../modules/skills/market/overview-queue";

/**
 * One skill version's AI overview, through the catalog overview engine's job
 * handling. A failure is thrown for BullMQ to retry with backoff; after the
 * last attempt the job stays failed, which keeps the scheduler from queueing
 * the same version again (see `overview-queue.ts`).
 */
export async function processSkillOverviewGenerateJob(
  job: Job<Record<string, unknown>>,
): Promise<GenerateSkillOverviewResult> {
  return skillOverviewJobs.process(
    job,
    async ({ versionId, requestId, force, scopeId }) =>
      generateSkillOverview({
        requestId,
        force,
        modelConfigurationKey:
          (await resolveSkillAnalysisModelKey()) ?? undefined,
        skillVersionId: versionId,
        scopeId,
        callModel: createSkillOverviewModelCall(),
      }),
  );
}
