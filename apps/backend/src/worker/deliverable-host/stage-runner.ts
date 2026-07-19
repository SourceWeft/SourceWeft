import {
  advanceArtifactPipelineSteps,
  type AdvanceArtifactPipelineStepAction,
  type AdvanceArtifactPipelineStepInput,
} from "../../modules/artifacts/pipeline-advance";
import type { DeliverableStageDefinition } from "@sourceweft/capability-contracts";
import type { ArtifactPipelineStep } from "@sourceweft/contracts/artifact-pipeline";
import { ContentError } from "../../modules/content/errors";

/**
 * Capability-agnostic deliverable pipeline mechanics: step advancement,
 * checkpoint skip, per-stage time budget + retry, ready/failed terminal
 * transitions, and overall-progress computation.
 *
 * Generalized from the video-presentation worker; a pipeline definition
 * supplies the stage catalog (ids/labels/budgets) and may override the
 * progress function (video does, to stay byte-identical with the web
 * client's shared contracts computation).
 */

/**
 * The stage catalog a pipeline declares. Same shape the capability contract
 * exposes — aliased rather than redeclared so the two cannot drift (they
 * previously typechecked only because they were structurally identical).
 */
export type DeliverableStageDescriptor = DeliverableStageDefinition;

export type DeliverableGenerationState = {
  status: "pending" | "running" | "ready" | "failed";
  stage: string;
  progress: number;
  checkpointStage?: string;
  pipelineSteps?: ArtifactPipelineStep[];
  errorCode?: string;
  errorMessage?: string;
  attempt?: number;
  maxAttempts?: number;
  retrying?: boolean;
};

export type DeliverableStateLike = {
  generation: DeliverableGenerationState;
};

/**
 * Aliases of the artifact-pipeline advance contract this module delegates to
 * (`advanceArtifactPipelineSteps`). Kept as re-exports rather than parallel
 * declarations so a new action cannot be added to one and missed by the other.
 */
export type AdvanceDeliverableStepAction = AdvanceArtifactPipelineStepAction;

export type AdvanceDeliverableStepInput = AdvanceArtifactPipelineStepInput;

export type StageBudgetConfig = {
  budgetMs: number;
  maxAttempts: number;
};

export class StageBudgetExceededError extends Error {
  readonly stageId: string;

  constructor(stageId: string, message: string) {
    super(message);
    this.name = "StageBudgetExceededError";
    this.stageId = stageId;
  }
}

/**
 * Default overall-progress: budget-weighted stage completion, capped at 99
 * until every step completes. Pipelines whose clients compute progress
 * independently (video) must override with the shared function instead.
 */
export function createBudgetWeightedProgress(
  stages: readonly DeliverableStageDescriptor[],
) {
  const totalBudget = stages.reduce((sum, stage) => sum + stage.budgetMs, 0);
  const weightByStage = new Map(
    stages.map((stage) => [
      stage.id,
      totalBudget > 0 ? stage.budgetMs / totalBudget : 1 / stages.length,
    ]),
  );
  return (steps: readonly ArtifactPipelineStep[]) => {
    if (steps.length === 0) {
      return 0;
    }
    let fraction = 0;
    let allCompleted = true;
    for (const step of steps) {
      const weight = weightByStage.get(step.id) ?? 0;
      if (step.status === "completed") {
        fraction += weight;
        continue;
      }
      allCompleted = false;
      if (step.status === "running" && typeof step.progress === "number") {
        fraction += weight * Math.min(1, Math.max(0, step.progress / 100));
      }
    }
    if (allCompleted) {
      return 100;
    }
    return Math.min(99, Math.round(fraction * 100));
  };
}

// A pipeline error that opted out of retries (DeliverablePipelineError shape).
// Structural check because third-party capability packages may bundle their
// own copy of the error class.
function isNonRetryableDeliverableError(error: unknown) {
  if (error instanceof ContentError) {
    return true;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { retryable?: unknown }).retryable === false &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

/**
 * Runs one stage with retries.
 *
 * `budgetMs` is a **retry gate, not a deadline**: it is checked before each
 * attempt and never interrupts one in flight. A stage that has already spent
 * its budget will not start another attempt, but a single slow attempt runs to
 * completion however long it takes. Do not read it as "this stage is capped at
 * N ms".
 *
 * That is deliberate rather than an oversight: every blocking call inside a
 * stage carries its own timeout — sandbox commands at
 * `config.sandbox.limits.commandTimeoutMs` (120s default) and model calls at
 * the gateway's `DEFAULT_TIMEOUT_MS` (30s) — so a wedged stage is bounded from
 * below, not here. Note the practical consequence: the declared budgets
 * (minutes) are mostly larger than those per-call timeouts, so `budgetMs`
 * rarely binds. Turning it into a hard deadline would start killing attempts
 * that legitimately run long, so it needs real duration data first.
 */
export async function runStageWithBudget<T>(input: {
  config: StageBudgetConfig;
  fn: (attempt: number) => Promise<T>;
  onRetry?: (input: {
    attempt: number;
    error: unknown;
    maxAttempts: number;
  }) => void | Promise<void>;
  stageId: string;
}): Promise<T> {
  const startedAt = Date.now();
  let lastError: unknown;

  for (let attempt = 1; attempt <= input.config.maxAttempts; attempt += 1) {
    if (Date.now() - startedAt > input.config.budgetMs) {
      throw new StageBudgetExceededError(
        input.stageId,
        `Stage ${input.stageId} exceeded budget of ${input.config.budgetMs}ms`,
      );
    }

    try {
      return await input.fn(attempt);
    } catch (error) {
      lastError = error;
      if (isNonRetryableDeliverableError(error)) {
        break;
      }
      if (attempt >= input.config.maxAttempts) {
        break;
      }
      await input.onRetry?.({
        attempt: attempt + 1,
        error,
        maxAttempts: input.config.maxAttempts,
      });
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(
        `Stage ${input.stageId} failed after ${input.config.maxAttempts} attempts`,
      );
}

export type DeliverableStageRunner = ReturnType<
  typeof createDeliverableStageRunner
>;

export function createDeliverableStageRunner(input: {
  stages: readonly DeliverableStageDescriptor[];
  computeOverallProgress?: (
    steps: readonly ArtifactPipelineStep[],
  ) => number;
}) {
  const stages = input.stages;
  const stageIds = stages.map((stage) => stage.id);
  const computeProgress =
    input.computeOverallProgress ?? createBudgetWeightedProgress(stages);
  const budgets = new Map<string, StageBudgetConfig>(
    stages.map((stage) => [
      stage.id,
      { budgetMs: stage.budgetMs, maxAttempts: stage.maxAttempts },
    ]),
  );

  const buildInitialSteps = (): ArtifactPipelineStep[] =>
    stages.map((stage) => ({
      id: stage.id,
      label: stage.label,
      status: "pending" as const,
    }));

  const cloneSteps = (state: DeliverableStateLike): ArtifactPipelineStep[] => {
    const existing = state.generation.pipelineSteps;
    if (existing && existing.length > 0) {
      return existing.map((step) => ({ ...step }));
    }
    return buildInitialSteps();
  };

  const advanceStep = <TState extends DeliverableStateLike>(
    state: TState,
    stepInput: AdvanceDeliverableStepInput,
  ): TState => {
    const steps = advanceArtifactPipelineSteps(cloneSteps(state), stepInput);
    const progress = computeProgress(steps);
    const checkpointStage =
      stepInput.action === "complete"
        ? stepInput.stageId
        : state.generation.checkpointStage;

    return {
      ...state,
      generation: {
        ...state.generation,
        checkpointStage,
        pipelineSteps: steps,
        progress,
        retrying: stepInput.action === "retry",
        stage: stepInput.stageId,
        status:
          stepInput.action === "fail"
            ? "failed"
            : state.generation.status === "ready"
              ? "ready"
              : "running",
        ...(stepInput.action === "fail" && stepInput.errorMessage
          ? { errorMessage: stepInput.errorMessage }
          : stepInput.action === "start" || stepInput.action === "complete"
            ? { errorCode: undefined, errorMessage: undefined, retrying: false }
            : {}),
        ...(typeof stepInput.attempt === "number"
          ? { attempt: stepInput.attempt }
          : {}),
        ...(typeof stepInput.maxAttempts === "number"
          ? { maxAttempts: stepInput.maxAttempts }
          : {}),
      },
    };
  };

  const updateStepProgress = <TState extends DeliverableStateLike>(
    state: TState,
    stepInput: Omit<AdvanceDeliverableStepInput, "action">,
  ): TState => advanceStep(state, { ...stepInput, action: "progress" });

  const markReady = <TState extends DeliverableStateLike>(
    state: TState,
  ): TState => {
    const now = new Date().toISOString();
    const steps = cloneSteps(state).map((step) =>
      step.status === "completed"
        ? step
        : {
            ...step,
            status: "completed" as const,
            completedAt: step.completedAt ?? now,
            progress: 100,
          },
    );
    const lastStage = steps.at(-1)?.id ?? stages.at(-1)?.id ?? "";

    return {
      ...state,
      generation: {
        ...state.generation,
        checkpointStage: lastStage,
        pipelineSteps: steps,
        progress: 100,
        retrying: false,
        stage: "ready",
        status: "ready",
        errorCode: undefined,
        errorMessage: undefined,
      },
    };
  };

  const markFailed = <TState extends DeliverableStateLike>(
    state: TState,
    failure: { errorCode: string; errorMessage: string },
  ): TState => {
    const steps = state.generation.pipelineSteps ?? [];
    const running = steps.find((step) => step.status === "running");
    const nextPending = steps.find((step) => step.status === "pending");
    const targetStageId = running?.id ?? nextPending?.id;
    const next = targetStageId
      ? advanceStep(state, {
          action: "fail",
          errorMessage: failure.errorMessage,
          stageId: targetStageId,
        })
      : state;
    const failedStep =
      next.generation.pipelineSteps?.find(
        (step) => step.status === "failed",
      ) ?? (targetStageId ? { id: targetStageId } : undefined);

    return {
      ...next,
      generation: {
        ...next.generation,
        checkpointStage: failedStep?.id ?? next.generation.checkpointStage,
        errorCode: failure.errorCode,
        errorMessage: failure.errorMessage,
        progress: 100,
        retrying: false,
        stage: "failed",
        status: "failed",
      },
    };
  };

  const shouldSkipStage = (skipInput: {
    checkpointStage?: string;
    stageId: string;
  }) => {
    if (!skipInput.checkpointStage) {
      return false;
    }
    const checkpointIndex = stageIds.indexOf(skipInput.checkpointStage);
    const stageIndex = stageIds.indexOf(skipInput.stageId);
    return (
      checkpointIndex >= 0 && stageIndex >= 0 && checkpointIndex >= stageIndex
    );
  };

  return {
    advanceStep,
    budgets,
    buildInitialSteps,
    markFailed,
    markReady,
    shouldSkipStage,
    stages,
    updateStepProgress,
  };
}
