import type { SkillSubmissionStages } from "@sourceweft/db";
import { logger } from "../../../../shared/logger";
import { RegistrySubmissionError } from "../errors";
import {
  describeIngestError,
  INGEST_DEADLINE_CODE,
  IngestSupersededError,
  isTransientIngestError,
} from "./errors";
import {
  claimSubmission,
  writeSubmissionProgress,
  type SubmissionFence,
  type SubmissionProgressPatch,
} from "./repository";
import {
  defaultIngestDeps,
  GITHUB_INGEST_STAGES,
  type IngestContext,
  type IngestDeps,
  type IngestStage,
} from "./stages";

/**
 * Runs one submission through the stage list, writing progress to its row as it
 * goes: `stage` is where the run is now, `stages` is each stage's status and
 * timing. The row is the only thing a polling client sees, so every transition
 * is persisted before the work it announces begins.
 */

export type IngestRunOutcome =
  | { status: "succeeded"; submissionId: string; skills: number }
  /** Nothing to run: the row is gone or already finished. */
  | { status: "skipped"; submissionId: string };

export async function runIngestPipeline(input: {
  submissionId: string;
  signal: AbortSignal;
  /**
   * Whether the queue will run this job again after a transient failure. When
   * it will, the row goes back to `queued` instead of `failed`, so a client
   * never sees a failure that is about to be retried away.
   */
  willRetryTransient: boolean;
  deps?: Partial<IngestDeps>;
  stages?: readonly IngestStage[];
}): Promise<IngestRunOutcome> {
  const submission = await claimSubmission(input.submissionId);
  if (!submission) {
    return { status: "skipped", submissionId: input.submissionId };
  }
  const fence: SubmissionFence = {
    id: submission.id,
    attempts: submission.attempts,
  };
  const ctx: IngestContext = {
    submission,
    signal: input.signal,
    deps: { ...defaultIngestDeps, ...input.deps },
  };
  const stagesState: SkillSubmissionStages = {};
  const persist = async (patch: SubmissionProgressPatch) => {
    if (!(await writeSubmissionProgress(fence, patch))) {
      throw new IngestSupersededError(submission.id);
    }
  };

  for (const stage of input.stages ?? GITHUB_INGEST_STAGES) {
    const startedAt = new Date().toISOString();
    try {
      // Before the stage is announced: a deadline that fired during the
      // previous stage must not show this one as started.
      input.signal.throwIfAborted();
      stagesState[stage.name] = { status: "running", startedAt };
      await persist({ stage: stage.name, stages: stagesState });

      const patch = await stage.run(ctx);

      stagesState[stage.name] = {
        status: "succeeded",
        startedAt,
        finishedAt: new Date().toISOString(),
      };
      await persist({ ...(patch ?? {}), stages: stagesState });
    } catch (caught) {
      if (caught instanceof IngestSupersededError) {
        throw caught;
      }
      // An abort surfaces as whatever the interrupted call rejects with; the
      // signal is the reliable witness that it was the deadline.
      const error = input.signal.aborted
        ? new RegistrySubmissionError(
            INGEST_DEADLINE_CODE,
            "The import did not finish within its time limit",
          )
        : caught;
      stagesState[stage.name] = {
        status: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        error: describeIngestError(error),
      };
      if (stage.optional && !input.signal.aborted) {
        logger.warn("Skill ingest optional stage failed", {
          submissionId: submission.id,
          stage: stage.name,
          error: stagesState[stage.name]?.error,
        });
        await persist({ stages: stagesState });
        continue;
      }

      const retrying = input.willRetryTransient && isTransientIngestError(error);
      // Best effort: if this write is refused the run was superseded, and the
      // original failure is still the more useful thing to surface.
      await writeSubmissionProgress(fence, {
        stages: stagesState,
        ...(ctx.results ? { results: ctx.results } : {}),
        ...(retrying
          ? { status: "queued" as const }
          : {
              status: "failed" as const,
              error: describeIngestError(error),
              finishedAt: new Date(),
            }),
      }).catch(() => false);
      throw error;
    }
  }

  await persist({ status: "succeeded", stage: null, finishedAt: new Date() });
  logger.info("Skill registry submission ingested", {
    submissionId: submission.id,
    source: submission.sourceInput,
    submittedBy: submission.submittedBy,
    skills: ctx.results?.length ?? 0,
  });
  return {
    status: "succeeded",
    submissionId: submission.id,
    skills: ctx.results?.length ?? 0,
  };
}
