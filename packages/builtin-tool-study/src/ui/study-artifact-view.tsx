"use client";

import { LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import {
  parseStudyContentForArtifact,
  studyErrorCodeSchema,
  type StudyContent,
} from "@sourceweft/contracts/study";
import type { ArtifactPreviewArtifactView } from "@sourceweft/contracts/artifact-ui";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { FlashcardsViewer } from "./flashcards/flashcards-viewer";
import { MindmapViewer } from "./mindmap/mindmap-viewer";
import { QuizViewer } from "./quiz/quiz-viewer";
import { StudyCannotDisplay, StudyErrorBoundary } from "./shared/error-boundary";
import { parsePublicStudyContent } from "./shared/public-content";
import { StaleBanner } from "@sourceweft/grounded-generation/ui";
import { useStudyHost, type StudyVersionRef } from "./study-host";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `payload.study.progress` while generating; tolerant of anything else. */
function readProgress(payload: Record<string, unknown>) {
  const progress = record(record(payload.study)?.progress);
  const completed = progress?.completed;
  const total = progress?.total;
  return typeof completed === "number" && typeof total === "number" && total > 0
    ? { completed: Math.min(completed, total), total }
    : null;
}

function parseContent(artifactType: string, payload: unknown): StudyContent | null {
  try {
    return parseStudyContentForArtifact(artifactType, payload);
  } catch {
    return null;
  }
}

/**
 * Everything a study artifact shows in the preview panel or share page:
 * generation progress, a worded failure with retry, or the viewer for its
 * type behind an error boundary. An invalid payload shows "cannot display"
 * rather than blanking the panel.
 */
export function StudyArtifactView({
  artifact,
  payload,
  title,
  interactive,
}: {
  artifact: ArtifactPreviewArtifactView;
  payload: Record<string, unknown>;
  title?: string | null;
  /** False narrows the host (the share page never records learning state). */
  interactive?: boolean;
}) {
  const host = useStudyHost();
  const t = host.useTranslate();
  const version: StudyVersionRef = {
    workspaceId: artifact.workspaceId,
    artifactId: artifact.id,
    artifactVersionId: artifact.artifactVersionId ?? null,
  };

  if (artifact.status === "pending" || artifact.status === "running") {
    const progress = readProgress(payload);
    return (
      <div
        className="flex h-full min-h-40 flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground"
        role="status"
      >
        <LoaderCircle aria-hidden className="size-5 animate-spin" />
        <p>
          {progress
            ? t("study.status.generating", progress)
            : t("study.status.queued")}
        </p>
      </div>
    );
  }

  if (artifact.status === "failed") {
    const code = studyErrorCodeSchema.safeParse(artifact.errorCode);
    const regenerate = host.requestRegenerate;
    return (
      <div
        className="flex h-full min-h-40 flex-col items-center justify-center gap-3 p-6 text-center text-sm"
        role="alert"
      >
        <TriangleAlert aria-hidden className="size-5 text-destructive" />
        <p>{t(`study.error.code.${code.success ? code.data : "UNKNOWN"}`)}</p>
        {regenerate && interactive !== false && host.interactive ? (
          <Button onClick={() => regenerate(version)} size="sm" type="button" variant="outline">
            <RefreshCw aria-hidden />
            {t("study.error.retry")}
          </Button>
        ) : null}
      </div>
    );
  }

  // The share page (not interactive) gets a payload with no source text and
  // shows no evidence; a quote left in by mistake is dropped here too.
  const content =
    interactive === false
      ? parsePublicStudyContent(artifact.artifactType, payload)
      : parseContent(artifact.artifactType, payload);
  if (!content) return <StudyCannotDisplay />;

  return (
    <StudyErrorBoundary>
      <div className="flex h-full min-h-0 flex-col gap-2">
        {interactive !== false ? (
          <div className="px-4 pt-3 empty:hidden">
            <StaleBanner version={version} />
          </div>
        ) : null}
        <div className="min-h-0 flex-1">
          {content.kind === "flashcards" ? (
            <FlashcardsViewer
              content={content}
              interactive={interactive}
              title={title}
              version={version}
            />
          ) : content.kind === "quiz" ? (
            <QuizViewer content={content} interactive={interactive} version={version} />
          ) : (
            <MindmapViewer
              content={content}
              interactive={interactive}
              title={title}
              version={version}
            />
          )}
        </div>
      </div>
    </StudyErrorBoundary>
  );
}
