import { config } from "../../shared/config";
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
import { enqueueSkillIngestJob } from "../../modules/skills/registry/ingest/queue";
import { failSubmissionIfInFlight } from "../../modules/skills/registry/ingest/repository";
import type { IngestDeps } from "../../modules/skills/registry/ingest/stages";

/** Dedicated import queue concurrency; bounded separately from chat work. */
export const SKILL_INGEST_WORKER_CONCURRENCY =
  config.skillIngestWorkerConcurrency;

/**
 * Wall-clock budget of one attempt before the source is listed. Delivered as
 * an AbortSignal, so it cuts a stalled GitHub transfer short and is checked
 * between stages and skills.
 */
export const SKILL_INGEST_JOB_DEADLINE_MS = 10 * 60_000;
/**
 * Added per listed file once the count is known: the subtree transport fetches
 * each file on its own, so a large repository needs more time than a small one
 * even when nothing is wrong. Capped so a listing at the file limit cannot hold
 * a worker slot indefinitely.
 */
export const SKILL_INGEST_PER_FILE_MS = 50;
export const SKILL_INGEST_MAX_FILE_EXTENSION_MS = 20 * 60_000;

/** The whole budget of an attempt that lists `fileCount` files. */
export function skillIngestDeadlineMs(
  fileCount: number,
  baseMs = SKILL_INGEST_JOB_DEADLINE_MS,
): number {
  const files =
    Number.isFinite(fileCount) && fileCount > 0 ? Math.floor(fileCount) : 0;
  return (
    baseMs +
    Math.min(
      files * SKILL_INGEST_PER_FILE_MS,
      SKILL_INGEST_MAX_FILE_EXTENSION_MS,
    )
  );
}

/**
 * A deadline that starts at `baseMs` and moves out, never in, once the file
 * count is known. Its timer is unreferenced like `AbortSignal.timeout`'s, and
 * cleared when the run ends, so a finished job keeps nothing alive.
 */
function startIngestDeadline(baseMs: number) {
  const controller = new AbortController();
  const startedAt = Date.now();
  let budgetMs = baseMs;
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () =>
        controller.abort(
          new DOMException("The ingest attempt timed out", "TimeoutError"),
        ),
      Math.max(0, startedAt + budgetMs - Date.now()),
    );
    timer.unref();
  };
  arm();
  return {
    signal: controller.signal,
    onFileCount(count: number) {
      const next = skillIngestDeadlineMs(count, baseMs);
      if (controller.signal.aborted || next <= budgetMs) return;
      budgetMs = next;
      arm();
    },
    clear() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

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
    throw new UnrecoverableError(
      "skill-registry-ingest job has no submissionId",
    );
  }
  const maxAttempts = job.opts?.attempts ?? 1;
  const deadline = startIngestDeadline(
    options.deadlineMs ?? SKILL_INGEST_JOB_DEADLINE_MS,
  );
  let outcome: IngestRunOutcome;
  try {
    outcome = await runIngestPipeline({
      submissionId,
      signal: deadline.signal,
      onFileCount: deadline.onFileCount,
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
  } finally {
    deadline.clear();
  }
  if (outcome.status === "deferred") {
    // A new job rather than this one retried: a BullMQ retry would come back
    // in seconds and spend an attempt on a limit that has hours to run. The
    // claim bumped `attempts`, so the job id is fresh. Should the enqueue
    // fail, throwing lets BullMQ retry this job, which meets the limit again
    // and tries the enqueue again — and the failure boundary closes the row
    // if it never succeeds.
    await enqueueSkillIngestJob(outcome.submission, {
      notBefore: outcome.resumeAt,
    });
  }
  return outcome;
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
