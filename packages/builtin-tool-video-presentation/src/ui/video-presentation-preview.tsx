"use client";

/**
 * Browser preview for a `video_presentation` artifact.
 *
 * This is the read side: parse the stored project payload, compile the
 * generated scene modules in the browser, and mount a Remotion Player over the
 * result — plus the chrome that reports where a still-running job is. Writing a
 * file out of it is a separate concern and lives in `video-presentation-export`.
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  compileVideoPresentationScenesOnBrowser,
  createPlaceholderCompiledScenes,
  getVideoDurationSeconds,
  parseVideoPresentationProject,
  VideoPresentationPlayer,
  type CompiledVideoPresentationScene,
  type VideoPresentationSceneCompileDiagnostic,
} from "@sourceweft/video-presentation-runtime";
import {
  canRenderVideoPresentationScenes,
  isVideoPresentationFailed,
  resolveVideoProjectStageLabel,
} from "./artifact-view";
import { VideoPresentationExportControls } from "./video-presentation-export";

export type VideoPresentationPreviewProps = {
  artifactStatus: string;
  errorMessage?: string | null;
  payload: Record<string, unknown>;
  /**
   * Absolutizes a backend-relative asset path. Injected because per-scene audio
   * is served by the API, and this package must not know the app's API origin.
   */
  resolveAssetUrl: (value: string) => string;
  title: string;
};

export function VideoPresentationPreview({
  artifactStatus,
  errorMessage,
  payload,
  resolveAssetUrl,
  title,
}: VideoPresentationPreviewProps) {
  const generation =
    payload.generation &&
    typeof payload.generation === "object" &&
    !Array.isArray(payload.generation)
      ? (payload.generation as Record<string, unknown>)
      : null;
  const generationError =
    typeof generation?.errorMessage === "string"
      ? generation.errorMessage
      : typeof errorMessage === "string"
        ? errorMessage
        : null;
  const generationProgress =
    typeof generation?.progress === "number" &&
    Number.isFinite(generation.progress)
      ? Math.max(0, Math.min(100, generation.progress))
      : 0;
  const generationAttempt =
    typeof generation?.attempt === "number" ? generation.attempt : null;
  const generationMaxAttempts =
    typeof generation?.maxAttempts === "number" ? generation.maxAttempts : null;
  const generationIsRetrying = generation?.retrying === true;
  const isFailed = isVideoPresentationFailed({ artifactStatus, payload });
  const project = useMemo(
    () => (isFailed ? null : parseVideoPresentationProject(payload)),
    [isFailed, payload],
  );
  const fallbackScenes = useMemo(
    () => (project ? createPlaceholderCompiledScenes(project) : []),
    [project],
  );
  const [compiledScenes, setCompiledScenes] =
    useState<CompiledVideoPresentationScene[]>(fallbackScenes);
  const [compileDiagnostics, setCompileDiagnostics] = useState<
    VideoPresentationSceneCompileDiagnostic[]
  >([]);
  const [isCompilingScenes, setIsCompilingScenes] = useState(false);
  const isPreparing =
    artifactStatus === "pending" || artifactStatus === "running";
  const durationSeconds = project ? getVideoDurationSeconds(project) : null;

  useEffect(() => {
    let cancelled = false;
    if (isFailed) {
      setCompiledScenes([]);
      setCompileDiagnostics([]);
      setIsCompilingScenes(false);
      return;
    }
    if (!project || project.sceneModules.length === 0) {
      setCompiledScenes(fallbackScenes);
      setCompileDiagnostics([]);
      setIsCompilingScenes(false);
      return;
    }

    setIsCompilingScenes(true);
    void compileVideoPresentationScenesOnBrowser(project, {
      resolveAudioUrl: resolveAssetUrl,
      useFallbackForFailedScenes: false,
    })
      .then((result) => {
        if (cancelled) {
          return;
        }
        setCompiledScenes(result.scenes);
        setCompileDiagnostics(result.diagnostics);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setCompiledScenes(fallbackScenes);
        setCompileDiagnostics([
          {
            errorMessage:
              error instanceof Error
                ? error.message
                : "Could not compile video scene modules.",
            slideNumber: 1,
            title: project.project.title,
          },
        ]);
      })
      .finally(() => {
        if (!cancelled) {
          setIsCompilingScenes(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [fallbackScenes, isFailed, project, resolveAssetUrl]);

  if (isFailed) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-center">
        <p className="text-sm font-medium text-destructive">
          Video project generation failed
        </p>
        <p className="mt-2 text-xs leading-5 text-destructive/80">
          {generationError ??
            "The video presentation worker failed before producing a ready project."}
        </p>
      </div>
    );
  }

  const canRenderPreparedScenes =
    Boolean(project) &&
    canRenderVideoPresentationScenes({
      compiledSceneCount: compiledScenes.length,
      diagnosticCount: compileDiagnostics.length,
      isCompilingScenes,
      isPreparing,
      sceneModuleCount: project?.sceneModules.length ?? 0,
      slideCount: project?.slides.length ?? 0,
    });

  if (!project && isPreparing) {
    return (
      <div className="rounded-xl border bg-background p-4 text-center shadow-sm">
        <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        <p className="mt-3 text-sm font-medium text-foreground">
          Preparing video project
        </p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {resolveVideoProjectStageLabel(payload)}
        </p>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-center">
        <p className="text-sm font-medium text-destructive">
          {artifactStatus === "failed"
            ? "Video project generation failed"
            : "Video project is unavailable"}
        </p>
        <p className="mt-2 text-xs leading-5 text-destructive/80">
          {generationError ??
            "The video presentation payload does not contain valid scene modules."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="w-full overflow-hidden rounded-xl border bg-background shadow-sm">
        <div className="grid gap-2 border-b px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="min-w-0 pr-2">
            <p className="whitespace-nowrap text-xs font-medium text-foreground">
              Video Presentation
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {project.slides.length} slides
              {durationSeconds
                ? ` · ${durationSeconds.toFixed(1)}s`
                : null} · {project.project.fps}fps
              {isCompilingScenes ? " · compiling scenes" : null}
            </p>
          </div>
          <VideoPresentationExportControls
            canExport={canRenderPreparedScenes}
            payload={project}
            scenes={compiledScenes}
            title={title}
          />
        </div>
        {isPreparing ? (
          <div className="border-b bg-muted/30 px-3 py-2.5">
            <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
              <span className="min-w-0 truncate">
                {generationIsRetrying
                  ? "Retrying video generation"
                  : resolveVideoProjectStageLabel(payload)}
              </span>
              <span className="shrink-0 tabular-nums">
                {generationProgress}%
                {generationAttempt && generationMaxAttempts
                  ? ` · attempt ${generationAttempt}/${generationMaxAttempts}`
                  : ""}
              </span>
            </div>
            <div
              aria-label="Video presentation generation progress"
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={generationProgress}
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
              role="progressbar"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300"
                style={{ width: `${generationProgress}%` }}
              />
            </div>
          </div>
        ) : null}
        {compileDiagnostics.length > 0 ? (
          <div className="border-b bg-amber-500/10 px-3 py-2 text-[11px] leading-5 text-amber-900 dark:text-amber-200">
            {compileDiagnostics.length} scene
            {compileDiagnostics.length === 1 ? "" : "s"} failed to compile.
            Video playback and export are disabled until the project is
            repaired.
          </div>
        ) : null}
        <div className="bg-[#0b1017] p-2">
          {canRenderPreparedScenes ? (
            <VideoPresentationPlayer
              className="mx-auto max-h-[calc(100vh-12rem)] w-full overflow-hidden rounded-lg bg-black"
              payload={project}
              scenes={compiledScenes}
            />
          ) : (
            <div className="flex min-h-64 flex-col items-center justify-center rounded-lg border border-white/10 bg-black px-6 py-10 text-center text-white">
              <Loader2 className="mb-3 size-5 animate-spin text-white/60" />
              <p className="text-sm font-medium">
                {compileDiagnostics.length > 0
                  ? "Video scenes need repair"
                  : isPreparing
                    ? resolveVideoProjectStageLabel(payload)
                    : "Compiling video scenes"}
              </p>
              <p className="mt-2 max-w-md text-xs leading-5 text-white/60">
                {compileDiagnostics.length > 0
                  ? compileDiagnostics
                      .map(
                        (diagnostic) =>
                          `Slide ${diagnostic.slideNumber}: ${diagnostic.errorMessage}`,
                      )
                      .join(" ")
                  : "The browser preview will appear once every generated scene module compiles successfully."}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
