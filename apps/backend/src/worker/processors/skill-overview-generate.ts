import type { Job } from "bullmq";
import { billingRuntime as billingService } from "../../billing-host/bindings";
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
  const attempt = job.attemptsMade + 1;
  try {
    const result = await generateSkillOverview({
      skillVersionId: payload.skillVersionId,
      // One billing scope per try, so a retry is charged as the new call it is
      // and a stalled redelivery of the same try is not charged twice.
      scopeId: `skill-overview:${String(job.id)}:${attempt}`,
      // The job payload cannot carry a port, so the processor supplies the
      // same singleton every worker model call is billed through.
      callModel: createSkillOverviewModelCall(billingService),
    });
    if (result.status === "skipped") {
      logger.debug("Skill overview job skipped", {
        skillVersionId: payload.skillVersionId,
        reason: result.reason,
      });
    }
    return result;
  } catch (error) {
    const isLastAttempt = attempt >= (job.opts.attempts ?? 1);
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
