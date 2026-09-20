import { UnrecoverableError, type Job } from "bullmq";
import { logger } from "../../shared/logger";
import {
  describeIngestError,
  IngestSupersededError,
  isTransientIngestError,
} from "../../modules/skills/registry/ingest/errors";
import {
  runIngestPipeline,
  type IngestRunOutcome,
} from "../../modules/skills/registry/ingest/pipeline";
import { failSubmissionIfInFlight } from "../../modules/skills/registry/ingest/repository";
import type { IngestDeps } from "../../modules/skills/registry/ingest/stages";

/** How many ingests one worker process runs at once. Not configurable. */
export const SKILL_INGEST_WORKER_CONCURRENCY = 2;

/**
 * Wall-clock budget of one attempt. Delivered as an AbortSignal, so it cuts a
 * stalled GitHub transfer short and is checked between stages and skills.
 */
export const SKILL_INGEST_JOB_DEADLINE_MS = 10 * 60_000;

const JOB_FAILED_CODE = "SKILL_INGEST_JOB_FAILED";

function submissionIdOf(data: Record<string, unknown>): string | null {
  return typeof data.submissionId === "string" && data.submissionId
    ? data.submissionId
    : null;
}

export async function processSkillRegistryIngestJob(
  job: Pick<Job<Record<string, unknown>>, "data" | "attemptsMade" | "opts">,
  options: { deps?: Partial<IngestDeps>; deadlineMs?: number } = {},
): Promise<IngestRunOutcome> {
  const submissionId = submissionIdOf(job.data);
  if (!submissionId) {
    throw new UnrecoverableError("skill-registry-ingest job has no submissionId");
  }
  const maxAttempts = job.opts?.attempts ?? 1;
  try {
    return await runIngestPipeline({
      submissionId,
      signal: AbortSignal.timeout(
        options.deadlineMs ?? SKILL_INGEST_JOB_DEADLINE_MS,
      ),
      willRetryTransient: job.attemptsMade + 1 < maxAttempts,
      deps: options.deps,
    });
  } catch (error) {
    if (error instanceof IngestSupersededError) {
      // Another run owns the row now. This one ends quietly rather than
      // failing: a failed job reaches the boundary below, which would close a
      // submission that its new owner is still working on.
      logger.warn("Skill ingest run superseded", { submissionId });
      return { status: "skipped", submissionId };
    }
    if (isTransientIngestError(error)) {
      throw error;
    }
    // Deterministic: the same source fails the same way every time. The
    // pipeline already recorded the failure on the row; tell BullMQ not to
    // spend the remaining attempts on it.
    const described = describeIngestError(error);
    throw new UnrecoverableError(`${described.code}: ${described.message}`);
  }
}

/**
 * Boundary cleanup for ingest jobs that end OUTSIDE the processor's own
 * failure handling — stalled past the limit after a worker crash, or failed
 * before the pipeline could write (database down at the wrong moment). Without
 * it the submission would read `running` forever and keep blocking a new import
 * of the same source.
 *
 * Only in-flight rows are touched, so whatever the processor recorded stands.
 * A failure BullMQ is about to retry is left alone.
 */
export async function handleSkillIngestJobFailure(input: {
  data: Record<string, unknown>;
  error: Error;
  /** The job's state in Redis after the failure was recorded. */
  getState: () => Promise<string>;
}): Promise<"marked" | "skipped"> {
  const submissionId = submissionIdOf(input.data);
  if (!submissionId) {
    return "skipped";
  }
  try {
    // `failed` = final. A job with attempts left is `delayed`/`waiting` here.
    // Asking the queue rather than counting attempts also covers the stalled
    // case, which fails a job that still has attempts on paper.
    if ((await input.getState()) !== "failed") {
      return "skipped";
    }
    const marked = await failSubmissionIfInFlight(submissionId, {
      code: JOB_FAILED_CODE,
      message: input.error.message || "The import job failed",
    });
    if (marked) {
      logger.warn("skill_ingest_job_failure_boundary_marked", {
        submissionId,
        error: input.error.message,
      });
    }
    return marked ? "marked" : "skipped";
  } catch (error) {
    logger.error("skill_ingest_job_failure_boundary_error", {
      submissionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return "skipped";
  }
}
