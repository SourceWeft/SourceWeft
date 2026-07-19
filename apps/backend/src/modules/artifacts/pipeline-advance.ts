import {
  applyArtifactPipelineStepPatch,
  type ArtifactPipelineStep,
  type ArtifactPipelineStepPatch,
} from "@sourceweft/contracts/artifact-pipeline";

export type AdvanceArtifactPipelineStepAction =
  | "start"
  | "complete"
  | "fail"
  | "retry"
  | "progress";

export type AdvanceArtifactPipelineStepInput = ArtifactPipelineStepPatch & {
  action: AdvanceArtifactPipelineStepAction;
  stageId: string;
};

function markRunningStepsCompleted(
  steps: ArtifactPipelineStep[],
  completedAt: string,
) {
  for (const step of steps) {
    if (step.status === "running") {
      step.status = "completed";
      step.completedAt = completedAt;
      step.progress = 100;
      step.errorMessage = undefined;
    }
  }
}

/**
 * Generic pipeline step advance. Mutates a cloned steps array; callers own
 * domain payload wrapping and progress aggregation.
 */
export function advanceArtifactPipelineSteps(
  steps: ArtifactPipelineStep[],
  input: AdvanceArtifactPipelineStepInput,
): ArtifactPipelineStep[] {
  const now = new Date().toISOString();
  const next = steps.map((step) => ({ ...step }));
  const currentIndex = next.findIndex((step) => step.id === input.stageId);
  if (currentIndex < 0) {
    return steps;
  }

  let current = next[currentIndex]!;
  const patch: ArtifactPipelineStepPatch = {
    summary: input.summary,
    display: input.display,
    input: input.input,
    output: input.output,
    logTail: input.logTail,
    metrics: input.metrics,
    stepProgress: input.stepProgress,
    errorMessage: input.errorMessage,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
  };

  if (input.action === "start") {
    markRunningStepsCompleted(next, now);
    current = {
      ...current,
      status: "running",
      startedAt: now,
      attempt: 1,
      maxAttempts: input.maxAttempts,
      errorMessage: undefined,
      progress:
        typeof input.stepProgress === "number" ? input.stepProgress : undefined,
    };
  } else if (input.action === "retry") {
    current = {
      ...current,
      status: "running",
      attempt: input.attempt ?? (current.attempt ?? 0) + 1,
      maxAttempts: input.maxAttempts ?? current.maxAttempts,
      errorMessage: input.errorMessage,
      progress:
        typeof input.stepProgress === "number" ? input.stepProgress : undefined,
    };
  } else if (input.action === "progress") {
    current = {
      ...current,
      status: "running",
    };
  } else if (input.action === "complete") {
    current = {
      ...current,
      status: "completed",
      completedAt: now,
      progress: 100,
      errorMessage: undefined,
    };
  } else if (input.action === "fail") {
    current = {
      ...current,
      status: "failed",
      completedAt: now,
      errorMessage: input.errorMessage,
    };
  }

  next[currentIndex] = applyArtifactPipelineStepPatch(current, patch);
  return next;
}
