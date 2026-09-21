import { config } from "../../../../shared/config";
import { enqueueWithAudit, skillIngestQueue } from "../../../../shared/queue";
import type { SkillSubmissionRow } from "./repository";

export const SKILL_REGISTRY_INGEST_JOB = "skill-registry-ingest";

/**
 * Attempts per enqueue. Only transient failures use them — the processor fails
 * a deterministic error with `UnrecoverableError`, which skips the rest.
 */
export const SKILL_INGEST_JOB_ATTEMPTS = 3;
const SKILL_INGEST_BACKOFF_MS = 5_000;

export type SkillRegistryIngestJobPayload = {
  submissionId: string;
  // Not read by the processor — the row is the source of truth. They let the
  // job audit trail attribute the job to its team and workspace.
  teamId: string;
  workspaceId: string;
};

/**
 * One job per (submission, user-level try). `attempts` is part of the id
 * because BullMQ ignores an `add` whose id already exists — including a job
 * that failed and is kept for inspection — so a retried submission needs a
 * fresh id, while enqueueing the same try twice stays a no-op.
 */
export async function enqueueSkillIngestJob(
  submission: Pick<
    SkillSubmissionRow,
    "id" | "teamId" | "workspaceId" | "attempts"
  >,
  options: {
    /** Run no earlier than this — a submission waiting out a rate limit. */
    notBefore?: Date;
  } = {},
) {
  const payload: SkillRegistryIngestJobPayload = {
    submissionId: submission.id,
    teamId: submission.teamId,
    workspaceId: submission.workspaceId,
  };
  return enqueueWithAudit(
    SKILL_REGISTRY_INGEST_JOB,
    payload,
    {
      jobId: `${SKILL_REGISTRY_INGEST_JOB}_${submission.id}_${submission.attempts}`,
      attempts: SKILL_INGEST_JOB_ATTEMPTS,
      backoff: { type: "exponential", delay: SKILL_INGEST_BACKOFF_MS },
      removeOnComplete: 100,
      removeOnFail: 100,
      ...(options.notBefore
        ? { delay: Math.max(0, options.notBefore.getTime() - Date.now()) }
        : {}),
    },
    { queue: skillIngestQueue, queueName: config.skillIngestQueueName },
  );
}
