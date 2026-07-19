import { useEffect, useState } from "react";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { ArtifactPipeline } from "./artifact-pipeline";
import type { ArtifactStatusSnapshot } from "./types";
import { formatCompactDuration } from "./duration-format";
import { useArtifactSnapshot } from "./use-artifact-snapshot";
import {
  isDeliverableGenerationActive,
  resolveDeliverableElapsedMs,
  resolveDeliverableProgress,
  resolveDeliverableTitle,
} from "./artifact-progress";

export function DeliverablePipeline({
  artifactSnapshot,
  className,
  toolCallOutput,
  toolCallStatus,
  toolName,
  workspaceId,
}: {
  artifactSnapshot?: ArtifactStatusSnapshot;
  className?: string;
  toolCallOutput?: unknown;
  toolCallStatus?: "running" | "completed" | "error" | "approval_requested";
  toolName: string;
  workspaceId?: string | null;
}) {
  const { snapshot } = useArtifactSnapshot({
    artifactSnapshot,
    toolCallOutput,
    workspaceId,
  });
  const progress = resolveDeliverableProgress({
    artifactSnapshot: snapshot,
    toolCallOutput,
    toolCallStatus,
    toolName,
  });
  const isGenerating = isDeliverableGenerationActive({
    artifactSnapshot: snapshot,
    toolCallOutput,
    toolCallStatus,
    toolName,
  });
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isGenerating) {
      return;
    }
    setNowMs(Date.now());
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isGenerating]);
  const elapsedMs = resolveDeliverableElapsedMs({
    artifactSnapshot: snapshot,
    nowMs,
    toolCallOutput,
    toolName,
  });

  // Tool has no artifact progress protocol registered — nothing to render.
  if (!progress) {
    return null;
  }

  const mode = progress.status === "ready" ? "history" : "live";
  const label = resolveDeliverableTitle(toolName);
  const title =
    progress.status === "failed"
      ? `${label} failed`
      : progress.status === "ready"
        ? `${label} pipeline`
        : `Building ${label.toLowerCase()}`;

  const stepCounts = `${progress.completedStepCount} / ${progress.totalStepCount}`;
  const footerRight =
    typeof elapsedMs === "number"
      ? `${formatCompactDuration(elapsedMs)} · ${stepCounts}`
      : stepCounts;

  return (
    <ArtifactPipeline
      activeStepId={progress.activeStepId}
      className={cn(className)}
      errorMessage={progress.errorMessage}
      footerRight={footerRight}
      mode={mode}
      status={progress.status}
      steps={progress.steps}
      title={title}
    />
  );
}
