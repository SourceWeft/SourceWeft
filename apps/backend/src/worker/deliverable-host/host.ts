import type { Job } from "bullmq";
import {
  isDeliverablePipelineErrorLike,
  type DeliverablePipelineDefinition,
  type DeliverablePreviewImage,
  type DeliverableStageViewPatch,
} from "@sourceweft/capability-contracts";
import type { ArtifactPipelineStep } from "@sourceweft/contracts/artifact-pipeline";
import { ContentError } from "../../modules/content/errors";
import {
  appendArtifactOutputToChatRun,
  findChatThreadRunById,
} from "../../modules/threads/durable/repository";
import { logger } from "../../shared/logger";
import {
  createDeliverableStageRunner,
  runStageWithBudget,
  type DeliverableStateLike,
} from "./stage-runner";
import type {
  DeliverableHostJobPayload,
  DeliverableRuntimeResolver,
} from "./context";

/**
 * Generic deliverable pipeline orchestrator: artifact load, per-stage
 * checkpoint/budget/retry, stage-view digests, progress persistence
 * (artifact payload + BullMQ job progress), terminal ready/failed
 * transitions and error mapping. All capability-specific behavior lives in
 * the injected DeliverablePipelineDefinition.
 */

const MAX_ERROR_MESSAGE_LENGTH = 1000;

function truncateText(value: string, maxLength: number) {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function toObjectRecordOrUndefined(
  value: unknown,
): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function updateDeliverableJobProgress(
  job: Job<Record<string, unknown>>,
  generation: DeliverableStateLike["generation"],
) {
  const updateProgress = (
    job as Job<Record<string, unknown>> & {
      updateProgress?: (value: unknown) => Promise<void>;
    }
  ).updateProgress;
  if (typeof updateProgress !== "function") {
    return;
  }
  await updateProgress.call(job, {
    attempt: generation.attempt,
    errorMessage: generation.errorMessage,
    maxAttempts: generation.maxAttempts,
    progress: generation.progress,
    retrying: generation.retrying ?? false,
    stage: generation.stage,
    status: generation.status,
  });
}

function stripCodePrefix(message: string, code: string) {
  const prefix = `${code}: `;
  return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}

async function assertArtifactOutputRunCanPublish(
  envelope: DeliverableHostJobPayload,
) {
  const origin = envelope.artifactOutputOrigin;
  if (!origin) {
    return;
  }
  const run = await findChatThreadRunById({
    runId: origin.threadRunId,
    teamId: envelope.teamId,
    workspaceId: envelope.workspaceId,
  });
  if (!run) {
    throw new ContentError(
      409,
      "ARTIFACT_OUTPUT_RUN_NOT_FOUND",
      "The chat run no longer exists, so the deliverable cannot publish.",
      { recoverable: false },
    );
  }
  if (
    run.status === "queued" ||
    run.status === "running" ||
    run.status === "waiting_for_approval"
  ) {
    return;
  }
  throw new ContentError(
    run.status === "cancel_requested" || run.status === "cancelled" ? 499 : 409,
    run.status === "cancel_requested" || run.status === "cancelled"
      ? "CLIENT_CANCELLED"
      : "ARTIFACT_OUTPUT_RUN_INACTIVE",
    run.status === "failed"
      ? "The chat run failed before the deliverable could publish."
      : run.status === "completed"
        ? "The chat run completed before the deliverable could publish."
        : "The chat run was cancelled before the deliverable could publish.",
    { recoverable: false },
  );
}

export function createDeliverableProcessor<TState extends DeliverableStateLike>(
  definition: DeliverablePipelineDefinition<TState>,
  resolveRuntime: DeliverableRuntimeResolver,
) {
  const runner = createDeliverableStageRunner({
    stages: definition.stages,
    computeOverallProgress: definition.computeOverallProgress
      ? (steps: readonly ArtifactPipelineStep[]) =>
          definition.computeOverallProgress!(steps)
      : undefined,
  });

  return async function processDeliverableJob(
    job: Job<Record<string, unknown>>,
  ) {
    const envelope = job.data as DeliverableHostJobPayload;
    const runtime = await resolveRuntime(envelope);
    const prepared = definition.prepareJob(envelope);
    const artifact = await runtime.artifacts.find({
      teamId: envelope.teamId,
      workspaceId: envelope.workspaceId,
      artifactId: envelope.artifactId,
    });

    if (!artifact) {
      throw new Error(
        `Artifact not found for ${definition.id} job ${envelope.jobId}`,
      );
    }

    // Captured from the same row read that supplies the payload, and never
    // re-read: it is the version this run is about to regenerate from, so
    // taking it any later would let an edit that published mid-run pass the
    // check it exists to fail.
    const baseVersionNo = artifact.currentVersionNo;

    let state: TState;
    try {
      state = definition.loadState(artifact.payloadJson);
    } catch (error) {
      const code = isDeliverablePipelineErrorLike(error)
        ? error.code
        : definition.invalidPayloadErrorCode;
      const rawMessage = truncateText(
        error instanceof Error
          ? stripCodePrefix(error.message, code)
          : `Invalid ${definition.id} artifact payload`,
        MAX_ERROR_MESSAGE_LENGTH,
      );
      await runtime.artifacts.markFailed({
        artifactId: envelope.artifactId,
        teamId: envelope.teamId,
        workspaceId: envelope.workspaceId,
        expectedStatuses: ["pending", "running"],
        errorCode: code,
        errorMessage: rawMessage,
        payload: toObjectRecordOrUndefined(artifact.payloadJson),
      });
      throw new ContentError(502, code, `${code}: ${rawMessage}`, {
        recoverable: true,
      });
    }

    let runMode: "create" | "edit" = "create";
    if (definition.prepareRun) {
      const preparedRun = definition.prepareRun({
        job: envelope,
        prepared,
        state,
      });
      state = preparedRun.state;
      runMode = preparedRun.mode;
    }

    const scratch: Record<string, unknown> = {};
    // Set by any stage via api.setPreviewImage; persisted onto the artifact
    // record at publish time. Null means "keep the existing thumbnail". Held in
    // a ref because control-flow analysis ignores assignments made in closures.
    const previewImageRef: { current: DeliverablePreviewImage | null } = {
      current: null,
    };

    const persistGeneration = async () => {
      // Edit runs keep the published version untouched while regenerating:
      // progress is reported via job progress only; the payload is written
      // once at the end by the completion (new version).
      if (runMode !== "edit") {
        await runtime.artifacts.markRunning({
          artifactId: envelope.artifactId,
          teamId: envelope.teamId,
          workspaceId: envelope.workspaceId,
          expectedStatuses: ["pending", "running"],
          payload: state as unknown as Record<string, unknown>,
        });
      }
      await updateDeliverableJobProgress(job, state.generation);
    };

    const advanceStage = async (
      stageId: string,
      action: "start" | "complete" | "fail" | "retry",
      extras?: {
        attempt?: number;
        errorMessage?: string;
        maxAttempts?: number;
        applyStageView?: boolean;
      },
    ) => {
      const stageView =
        extras?.applyStageView === true
          ? definition.buildStageView(stageId, state)
          : undefined;
      state = runner.advanceStep(state, {
        action,
        stageId,
        ...(extras?.attempt !== undefined ? { attempt: extras.attempt } : {}),
        ...(extras?.errorMessage !== undefined
          ? { errorMessage: extras.errorMessage }
          : {}),
        ...(extras?.maxAttempts !== undefined
          ? { maxAttempts: extras.maxAttempts }
          : {}),
        ...stageView,
      });
      await persistGeneration();
    };

    try {
      for (const stage of definition.stages) {
        await assertArtifactOutputRunCanPublish(envelope);
        if (
          runner.shouldSkipStage({
            checkpointStage: state.generation.checkpointStage,
            stageId: stage.id,
          })
        ) {
          continue;
        }

        const config = runner.budgets.get(stage.id)!;
        const stageStartedAt = Date.now();
        logger.info("artifact_pipeline.stage.start", {
          pipeline: definition.id,
          artifactId: envelope.artifactId,
          stageId: stage.id,
          attempt: 1,
          maxAttempts: config.maxAttempts,
        });
        await advanceStage(stage.id, "start", {
          maxAttempts: config.maxAttempts,
        });

        await runStageWithBudget({
          config,
          stageId: stage.id,
          onRetry: async ({ attempt, error }) => {
            const errorMessage =
              error instanceof Error
                ? error.message
                : `Unknown ${definition.id} stage error`;
            logger.warn("artifact_pipeline.stage.retry", {
              pipeline: definition.id,
              artifactId: envelope.artifactId,
              stageId: stage.id,
              attempt,
              maxAttempts: config.maxAttempts,
              errorMessage: truncateText(
                errorMessage,
                MAX_ERROR_MESSAGE_LENGTH,
              ),
            });
            await advanceStage(stage.id, "retry", {
              attempt,
              errorMessage: truncateText(
                errorMessage,
                MAX_ERROR_MESSAGE_LENGTH,
              ),
              maxAttempts: config.maxAttempts,
            });
          },
          fn: async () => {
            state = await definition.runStage({
              stageId: stage.id,
              state,
              ctx: runtime.ctx,
              job: envelope,
              prepared,
              scratch,
              api: {
                updateStageProgress: async (
                  patch: DeliverableStageViewPatch,
                ) => {
                  state = runner.updateStepProgress(state, {
                    stageId: stage.id,
                    ...patch,
                  });
                  await persistGeneration();
                },
                setPreviewImage: (image) => {
                  previewImageRef.current = image;
                },
              },
            });
          },
        });

        const stageView = definition.buildStageView(stage.id, state);
        logger.info("artifact_pipeline.stage.complete", {
          pipeline: definition.id,
          artifactId: envelope.artifactId,
          stageId: stage.id,
          summary: stageView.summary,
          metrics: stageView.metrics,
          durationMs: Date.now() - stageStartedAt,
        });
        await advanceStage(stage.id, "complete", { applyStageView: true });
      }

      await assertArtifactOutputRunCanPublish(envelope);
      state = runner.markReady(state);

      const readyPayload = definition.finalize({ state, job: envelope });

      const result = await runtime.artifacts.completeArtifact({
        artifactId: envelope.artifactId,
        artifactType: definition.artifactType,
        teamId: envelope.teamId,
        workspaceId: envelope.workspaceId,
        threadId: envelope.threadId,
        userId: envelope.userId,
        // Not written by the completion — the row keeps the title it was
        // opened with — but the write path requires every spec to name one, so
        // the artifact's own title is what this reports. The envelope is the
        // first source because an edit run carries the title the edit asked
        // for; `definition.id` is the last resort so a pipeline that names
        // neither still publishes rather than failing on a validation rule
        // about a field nothing stores.
        title:
          envelope.title?.trim() || artifact.title?.trim() || definition.id,
        payload: readyPayload,
        ...(previewImageRef.current
          ? {
              preview: {
                storageKey: previewImageRef.current.storageKey,
                metadata: previewImageRef.current.metadata,
              },
            }
          : {}),
        // Create runs own the transition out of pending/running, so a status
        // outside that set means a duplicate delivery already published. Edit
        // runs deliberately republish an artifact that is already ready, so
        // status alone cannot spot a duplicate edit — that is what
        // expectedVersionNo is for: the run republishes onto exactly the
        // version it read at the top, or it loses. The status set stays on top
        // of it so an edit still cannot publish onto a failed artifact, which
        // no version check would have caught (a failed artifact keeps its
        // version pointer).
        expectedStatuses:
          runMode === "edit"
            ? (["ready", "running", "pending"] as const)
            : (["pending", "running"] as const),
        ...(runMode === "edit" && baseVersionNo !== undefined
          ? { expectedVersionNo: baseVersionNo }
          : {}),
        ...(envelope.artifactOutputOrigin
          ? {
              publishRunFence: {
                runId: envelope.artifactOutputOrigin.threadRunId,
                teamId: envelope.teamId,
                workspaceId: envelope.workspaceId,
              },
            }
          : {}),
      });

      if (!result) {
        const current =
          runMode === "create"
            ? await runtime.artifacts.find({
                artifactId: envelope.artifactId,
                teamId: envelope.teamId,
                workspaceId: envelope.workspaceId,
              })
            : null;
        const outputOrigin = envelope.artifactOutputOrigin;
        if (
          current?.latestVersionId &&
          outputOrigin &&
          current.status === "ready"
        ) {
          await appendArtifactOutputToChatRun({
            artifactId: envelope.artifactId,
            artifactVersionId: current.latestVersionId,
            producer: outputOrigin.producer,
            runId: outputOrigin.threadRunId,
            sourceToolCallId: outputOrigin.sourceToolCallId,
            teamId: envelope.teamId,
            workspaceId: envelope.workspaceId,
          });
          return {
            artifactId: envelope.artifactId,
            status: "ready" as const,
            versionId: current.latestVersionId,
          };
        }
        logger.warn("Deliverable pipeline publish superseded", {
          pipeline: definition.id,
          artifactId: envelope.artifactId,
          jobId: envelope.jobId,
        });
        return {
          artifactId: envelope.artifactId,
          status: "superseded" as const,
        };
      }

      await updateDeliverableJobProgress(job, state.generation);

      logger.info("Deliverable pipeline published", {
        pipeline: definition.id,
        artifactId: envelope.artifactId,
        jobId: envelope.jobId,
        versionId: result.versionId,
      });

      const outputOrigin = envelope.artifactOutputOrigin;
      if (outputOrigin) {
        await appendArtifactOutputToChatRun({
          artifactId: result.artifactId,
          artifactVersionId: result.versionId,
          producer: outputOrigin.producer,
          runId: outputOrigin.threadRunId,
          sourceToolCallId: outputOrigin.sourceToolCallId,
          teamId: envelope.teamId,
          workspaceId: envelope.workspaceId,
        });
      }

      return {
        artifactId: envelope.artifactId,
        status: "ready" as const,
        versionId: result.versionId,
      };
    } catch (error) {
      const errorRecord = toObjectRecordOrUndefined(error);
      const errorMessage =
        error instanceof Error
          ? error.message
          : `Unknown ${definition.id} error`;
      const safeErrorMessage = truncateText(
        errorMessage,
        MAX_ERROR_MESSAGE_LENGTH,
      );
      const errorCode =
        error instanceof ContentError
          ? error.code
          : isDeliverablePipelineErrorLike(error)
            ? error.code
            : definition.defaultErrorCode;
      const failedState = runner.markFailed(state, {
        errorCode,
        errorMessage: safeErrorMessage,
      });
      const failedStageId =
        failedState.generation.pipelineSteps?.find(
          (step) => step.status === "failed",
        )?.id ?? failedState.generation.checkpointStage;
      logger.warn("artifact_pipeline.stage.fail", {
        pipeline: definition.id,
        artifactId: envelope.artifactId,
        stageId: failedStageId,
        errorCode,
        errorMessage: safeErrorMessage,
        ...(errorRecord?.gatewayDiagnostics
          ? { gatewayDiagnostics: errorRecord.gatewayDiagnostics }
          : {}),
        runMode,
      });
      if (runMode !== "edit") {
        // Edit failures must never destroy a working artifact: the published
        // version stays ready; the failure is surfaced via job state/logs.
        await runtime.artifacts.markFailed({
          artifactId: envelope.artifactId,
          teamId: envelope.teamId,
          workspaceId: envelope.workspaceId,
          expectedStatuses: ["pending", "running"],
          errorCode,
          errorMessage: safeErrorMessage,
          payload: failedState as unknown as Record<string, unknown>,
        });
      }
      await updateDeliverableJobProgress(job, failedState.generation);
      logger.warn("Deliverable pipeline failed", {
        pipeline: definition.id,
        artifactId: envelope.artifactId,
        error: safeErrorMessage,
        ...(errorRecord?.gatewayDiagnostics
          ? { gatewayDiagnostics: errorRecord.gatewayDiagnostics }
          : {}),
        jobId: envelope.jobId,
      });
      if (
        !(error instanceof ContentError) &&
        isDeliverablePipelineErrorLike(error)
      ) {
        // Preserve worker retry semantics: pipeline errors classify like the
        // ContentError instances the pre-host worker threw.
        throw new ContentError(
          error.category === "sandbox" ? 503 : 502,
          error.code,
          error.message,
          { recoverable: true },
        );
      }
      throw error;
    }
  };
}
