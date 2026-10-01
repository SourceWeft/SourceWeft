import type { Job } from "bullmq";
import { logger } from "../../shared/logger";
import type { SystemModelReadiness } from "../../shared/model-gateway/system-client";
import { enqueueWithAudit, jobsQueue } from "../../shared/queue";
import type {
  InterruptedOverview,
  OverviewGenerateResult,
  OverviewStore,
} from "./types";

/**
 * The durable side of overview generation: one BullMQ job per version on the
 * primary queue, reserved in the database before it is queued, queued behind
 * tenant work, retried a bounded number of times, and recovered when a
 * process dies between the reservation and the queue.
 */

export type OverviewJobReason = "scheduled" | "regenerate";

/**
 * Every overview job's queue priority. BullMQ takes jobs with no priority
 * (chat turns, titles, syncs, parses) before any prioritized job, so however
 * large the scheduler's batch, it never delays tenant work; a forced
 * regeneration from administration waits the same way. All overview kinds
 * share the value: the batch itself is their order.
 */
export const OVERVIEW_JOB_PRIORITY = 10;

/**
 * One kind's job. The payload carries the version (the only field the
 * processor reads — the analysis row is the source of truth), the entity
 * (for the job audit trail), the reason, and the reserved request id.
 */
export type OverviewJobSpec<
  TVersionKey extends string,
  TParentKey extends string,
> = {
  // The BullMQ job name; also the prefix of every job id.
  name: string;
  versionKey: TVersionKey;
  parentKey: TParentKey;
  // Tries per request, spaced out: a gateway hiccup or a malformed answer is
  // usually gone a minute later. After the last one the request is failed.
  attempts: number;
  backoffMs: number;
  // Prefix of each try's system-model scope id.
  scopePrefix: string;
  // Log wording: "<label> overview generation failed; will retry".
  label: string;
};

export type OverviewJobPayload<
  TVersionKey extends string,
  TParentKey extends string,
> = Record<TVersionKey | TParentKey, string> & {
  reason: OverviewJobReason;
  requestId?: string;
};

/** What one try of a job runs: the kind's generation for this request. */
export type OverviewJobRun<TSkip extends string> = (input: {
  versionId: string;
  requestId: string;
  force: boolean;
  scopeId: string;
}) => Promise<OverviewGenerateResult<TSkip>>;

export function createOverviewJobs<
  TVersionKey extends string,
  TParentKey extends string,
>(
  spec: OverviewJobSpec<TVersionKey, TParentKey>,
  store: Pick<
    OverviewStore<unknown, unknown>,
    "read" | "request" | "fail" | "findInterrupted"
  >,
) {
  type Payload = OverviewJobPayload<TVersionKey, TParentKey>;

  /**
   * The version's job id prefix: the scheduler skips a version while any job
   * under it exists (queued, retrying, or failed for good — which stands
   * until the content, and so the version, changes). Each request's job id
   * adds its request id, so a regeneration is never swallowed by an older
   * job.
   */
  function jobId(versionId: string): string {
    return `${spec.name}_${versionId}`;
  }

  /**
   * Reserves a request (or re-checks the given one) and queues its job.
   * Null when there is nothing to queue: already generated, or the given
   * request was superseded or finished. A queue failure is recorded on the
   * request before it is rethrown.
   */
  async function enqueue(payload: Payload, options: { jobId?: string } = {}) {
    const versionId = payload[spec.versionKey];
    const state = payload.requestId
      ? await store.read(versionId)
      : await store.request(versionId, payload.reason === "regenerate");
    if (
      !state ||
      (payload.requestId &&
        (state.requestId !== payload.requestId ||
          !["pending", "running"].includes(state.status)))
    )
      return null;
    try {
      return await enqueueWithAudit(
        spec.name,
        { ...payload, requestId: state.requestId },
        {
          jobId: options.jobId ?? `${jobId(versionId)}_${state.requestId}`,
          attempts: spec.attempts,
          backoff: { type: "exponential", delay: spec.backoffMs },
          priority: OVERVIEW_JOB_PRIORITY,
          removeOnComplete: true,
          removeOnFail: { count: 5_000 },
        },
      );
    } catch (error) {
      await store.fail(
        versionId,
        state.requestId,
        "Could not queue analysis; retry from administration",
        false,
      );
      throw error;
    }
  }

  /** Whether a job with this id is queued, running, delayed or failed. */
  async function exists(id: string): Promise<boolean> {
    const job = await jobsQueue.getJob(id);
    return Boolean(job);
  }

  function payloadOf(entry: InterruptedOverview): Payload {
    return {
      [spec.versionKey]: entry.versionId,
      [spec.parentKey]: entry.parentId,
      requestId: entry.requestId,
      reason: entry.force ? "regenerate" : "scheduled",
    } as Payload;
  }

  /** Repair a crash between the durable reservation and Redis enqueue; failed jobs stay failed. */
  async function recover(): Promise<number> {
    let recovered = 0;
    for (const entry of await store.findInterrupted()) {
      const job = await jobsQueue.getJob(
        `${jobId(entry.versionId)}_${entry.requestId}`,
      );
      if (job) {
        if ((await job.getState()) === "failed")
          await store.fail(
            entry.versionId,
            entry.requestId,
            "Worker job failed; retry from administration",
            false,
          );
        continue;
      }
      if (await enqueue(payloadOf(entry))) recovered++;
    }
    return recovered;
  }

  /**
   * One try of a job. A skip other than "already generated" fails the
   * request for good (there is nothing a retry would change); a throw fails
   * it for good on the last try and leaves it pending before that, then is
   * rethrown for BullMQ to retry with backoff.
   */
  async function process<TSkip extends string>(
    job: Job<Record<string, unknown>>,
    run: OverviewJobRun<TSkip>,
  ): Promise<OverviewGenerateResult<TSkip>> {
    const payload = job.data as Payload;
    const versionId = payload[spec.versionKey];
    if (typeof versionId !== "string" || !versionId) {
      throw new Error(`${spec.name} job has no ${spec.versionKey}`);
    }
    if (!payload.requestId) {
      const state = await store.request(
        versionId,
        payload.reason === "regenerate",
      );
      if (!state) return { status: "skipped", reason: "already-generated" };
      payload.requestId = state.requestId;
      await job.updateData(payload);
    }
    const requestId = payload.requestId;
    const attempt = job.attemptsMade + 1;
    try {
      const result = await run({
        versionId,
        requestId,
        force: payload.reason === "regenerate",
        // One scope per try, so each try's call is told apart in the logs.
        scopeId: `${spec.scopePrefix}:${String(job.id)}:${attempt}`,
      });
      if (result.status === "skipped") {
        if (result.reason !== "already-generated")
          await store.fail(versionId, requestId, result.reason, false);
        logger.debug(`${spec.label} overview job skipped`, {
          [spec.versionKey]: versionId,
          reason: result.reason,
        });
      }
      return result;
    } catch (error) {
      const isLastAttempt = attempt >= (job.opts.attempts ?? 1);
      await store.fail(
        versionId,
        requestId,
        "Analysis failed; check worker logs and retry",
        !isLastAttempt,
      );
      logger[isLastAttempt ? "warn" : "info"](
        isLastAttempt
          ? `${spec.label} overview generation failed for good; skipped until the content changes`
          : `${spec.label} overview generation failed; will retry`,
        {
          [spec.versionKey]: versionId,
          [spec.parentKey]: payload[spec.parentKey],
          attempt,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      throw error;
    }
  }

  return { spec, jobId, enqueue, exists, recover, process };
}

export type OverviewJobs<
  TVersionKey extends string,
  TParentKey extends string,
> = ReturnType<typeof createOverviewJobs<TVersionKey, TParentKey>>;

export type OverviewBatchDeps<TPayload> = {
  readModelReadiness: () => Promise<
    Pick<SystemModelReadiness, "ready" | "reason">
  >;
  // Versions that still need an overview, most important first.
  findCandidates: (
    limit: number,
  ) => Promise<Array<{ versionId: string; payload: TPayload }>>;
  jobExists: (jobId: string) => Promise<boolean>;
  recover?: () => Promise<number>;
  enqueue: (payload: TPayload) => Promise<unknown>;
};

/**
 * One scheduler tick: nothing while the system model is not ready; else
 * recover interrupted requests, then queue up to `batchSize` versions that
 * have no job yet, looking at up to `scanLimit` candidates (some already have
 * a job — queued, retrying, or failed for good — and are passed over).
 */
export async function enqueueOverviewBatch<TPayload>(
  deps: OverviewBatchDeps<TPayload>,
  options: {
    jobId: (versionId: string) => string;
    batchSize: number;
    scanLimit: number;
    label: string;
  },
): Promise<{ queued: number; skipped: number }> {
  const readiness = await deps.readModelReadiness();
  if (!readiness.ready) {
    logger.debug(
      `${options.label} overviews not queued: the system model is not ready`,
      { reason: readiness.reason },
    );
    return { queued: 0, skipped: 0 };
  }
  await deps.recover?.();
  // Cache reuse happens inside the versioned worker, never at scheduling.
  const candidates = await deps.findCandidates(options.scanLimit);
  let queued = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    if (queued >= options.batchSize) break;
    if (await deps.jobExists(options.jobId(candidate.versionId))) {
      skipped += 1;
      continue;
    }
    await deps.enqueue(candidate.payload);
    queued += 1;
  }
  if (queued > 0) {
    logger.info(`${options.label} overviews queued`, { queued, skipped });
  }
  return { queued, skipped };
}
