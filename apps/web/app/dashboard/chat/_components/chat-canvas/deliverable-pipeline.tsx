import { cn } from "@sourceweft/ui-web/lib/utils";
import { ArtifactPipeline } from "./artifact-pipeline";
import type { ArtifactStatusSnapshot } from "./types";
import {
  resolveDeliverableProgress,
  resolveDeliverableTitle,
} from "./artifact-progress";

export function DeliverablePipeline({
  artifactSnapshot,
  className,
  toolCallOutput,
  toolCallStatus,
  toolName,
}: {
  artifactSnapshot?: ArtifactStatusSnapshot;
  className?: string;
  toolCallOutput?: unknown;
  toolCallStatus?: "running" | "completed" | "error" | "approval_requested";
  toolName: string;
}) {
  const progress = resolveDeliverableProgress({
    artifactSnapshot,
    toolCallOutput,
    toolCallStatus,
    toolName,
  });

  // Tool has no artifact progress protocol registered — nothing to render.
  if (!progress) {
    return null;
  }

  const mode = progress.status === "ready" ? "history" : "live";
  const label = resolveDeliverableTitle(toolName);
  const failedStep = progress.steps.find((step) => step.status === "failed");
  const title =
    progress.status === "failed"
      ? `${label} failed${failedStep ? ` · ${failedStep.label}` : ""}`
      : progress.status === "ready"
        ? `${label} pipeline`
        : `Building ${label.toLowerCase()}`;

  const stepCounts = `${progress.completedStepCount} / ${progress.totalStepCount}`;
  const footerRight =
    failedStep &&
    typeof failedStep.attempt === "number" &&
    typeof failedStep.maxAttempts === "number" &&
    failedStep.maxAttempts > 1
      ? `${stepCounts} · attempt ${failedStep.attempt}/${failedStep.maxAttempts}`
      : stepCounts;

  return (
    <ArtifactPipeline
      activeStepId={progress.activeStepId}
      className={cn(className)}
      errorCode={progress.errorCode}
      errorMessage={progress.errorMessage}
      footerRight={footerRight}
      mode={mode}
      status={progress.status}
      steps={progress.steps}
      title={title}
    />
  );
}
