import { z } from "zod";

export const jobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const createJobRequestSchema = z.object({
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export const createJobResponseSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: jobStatusSchema,
});

export const jobDetailsResponseSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: jobStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const jobEventSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  type: z.enum(["created", "status_changed", "cancel_requested", "log"]),
  message: z.string(),
  createdAt: z.string(),
});

export const jobEventsResponseSchema = z.object({
  items: z.array(jobEventSchema),
});

export const cancelJobResponseSchema = z.object({
  id: z.string(),
  removed: z.literal(true),
});

export type JobStatus = z.infer<typeof jobStatusSchema>;
export type CreateJobRequest = z.infer<typeof createJobRequestSchema>;
export type CreateJobResponse = z.infer<typeof createJobResponseSchema>;
export type JobDetailsResponse = z.infer<typeof jobDetailsResponseSchema>;
export type JobEvent = z.infer<typeof jobEventSchema>;
export type JobEventsResponse = z.infer<typeof jobEventsResponseSchema>;
export type CancelJobResponse = z.infer<typeof cancelJobResponseSchema>;

/** Idempotency key prefix for runs started from the web client. */
export const SOURCEWEFT_WEB_RUN_IDEMPOTENCY_PREFIX = "sourceweft-web-run:";

/**
 * Suffix that turns a durable chat run's idempotency key into its stop key.
 *
 * Stopping a running chat run — two equivalent entry points:
 *
 * 1. Thread stream (canonical; SDK `ContentClient.stopThreadRun`):
 *    `POST /v1/workspaces/:workspaceId/threads/:threadId/stream` with body
 *    `{ idempotencyKey: runKey + SOURCEWEFT_WEB_RUN_STOP_SUFFIX, stream: false }`,
 *    where `runKey` is the run's own idempotency key. Only the member who
 *    started the run, with access to the workspace, may stop it; anything
 *    else is `404`. The response is the turn's persisted result
 *    (`thread`, `userMessage`, `assistantMessage`, `billing`, `retrieval`), or,
 *    when the stopped run has no result to return, `{ threadRun, billing,
 *    retrieval }` with the run's terminal status. The call waits a bounded
 *    time for the worker to settle the run.
 * 2. Jobs API (SDK `JobsClient.cancelJob`): `POST /v1/jobs/:id/cancel` on the
 *    run's `thread-chat-run` job delegates to the same durable stop, with the
 *    same authorization (workspace, thread and key read from the run, never
 *    from job data), instead of removing the queue job. It returns as soon as
 *    the cancellation is persisted, with the usual `{ id, removed: true }`
 *    (`removed` meaning the run will not continue; the queue entry itself is
 *    left for the worker to settle). Unknown or foreign jobs are `404`.
 *    Other job types keep queue semantics: an active job is `409 JOB_RUNNING`.
 *
 * Both are idempotent: stopping a run that is already cancelled, finished or
 * failed — including one that finishes while the stop is in flight — succeeds
 * without changing its terminal state, never `409`.
 */
export const SOURCEWEFT_WEB_RUN_STOP_SUFFIX = ":stop";
