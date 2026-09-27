import { resolveSkillAnalysisModelKey } from "../../modules/skills/market/analysis-model";
import {
  failSkillAnalysis,
  requestSkillAnalysis,
} from "../../modules/skills/market/analysis-repository";
import type { Job } from "bullmq";
import { logger } from "../../shared/logger";
import {
  createSkillOverviewModelCall,
  generateSkillOverview,
  type GenerateSkillOverviewResult,
} from "../../modules/skills/market/overview-generate";
import type { SkillOverviewGenerateJobPayload } from "../../modules/skills/market/overview-queue";

/**
 * One skill version's AI overview. A failure is thrown for BullMQ to retry
 * with backoff; after the last attempt the job stays failed, which keeps the
 * scheduler from queueing the same version again (see `overview-queue.ts`).
 */
export async function processSkillOverviewGenerateJob(
  job: Job<Record<string, unknown>>,
): Promise<GenerateSkillOverviewResult> {
  const payload = job.data as SkillOverviewGenerateJobPayload;
  if (typeof payload.skillVersionId !== "string" || !payload.skillVersionId) {
    throw new Error("skill-overview-generate job has no skillVersionId");
  }
  if (!payload.requestId) {
    const state = await requestSkillAnalysis(
      payload.skillVersionId,
      payload.reason === "regenerate",
    );
    if (!state) return { status: "skipped", reason: "already-generated" };
    payload.requestId = state.requestId;
    await job.updateData(payload);
  }
  const attempt = job.attemptsMade + 1;
  try {
    const result = await generateSkillOverview({
      requestId: payload.requestId,
      force: payload.reason === "regenerate",
      modelConfigurationKey:
        (await resolveSkillAnalysisModelKey()) ?? undefined,
      skillVersionId: payload.skillVersionId,
      // One scope per try, so each try's call is told apart in the logs.
      scopeId: `skill-overview:${String(job.id)}:${attempt}`,
      callModel: createSkillOverviewModelCall(),
    });
    if (result.status === "skipped") {
      if (payload.requestId && result.reason !== "already-generated")
        await failSkillAnalysis(
          payload.skillVersionId,
          payload.requestId,
          result.reason,
          false,
        );
      logger.debug("Skill overview job skipped", {
        skillVersionId: payload.skillVersionId,
        reason: result.reason,
      });
    }
    return result;
  } catch (error) {
    const isLastAttempt = attempt >= (job.opts.attempts ?? 1);
    if (payload.requestId)
      await failSkillAnalysis(
        payload.skillVersionId,
        payload.requestId,
        "Analysis failed; check worker logs and retry",
        !isLastAttempt,
      );
    logger[isLastAttempt ? "warn" : "info"](
      isLastAttempt
        ? "Skill overview generation failed for good; skipped until the content changes"
        : "Skill overview generation failed; will retry",
      {
        skillVersionId: payload.skillVersionId,
        skillId: payload.skillId,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    throw error;
  }
}
