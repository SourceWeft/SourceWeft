import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Video } from "lucide-react";
import { toast } from "sonner";
import type { VideoPresentationProjectPayload } from "@sourceweft/contracts/video-presentation";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  compileVideoPresentationScenesOnBrowser,
  createPlaceholderCompiledScenes,
  type CompiledVideoPresentationScene,
  type VideoPresentationSceneCompileDiagnostic,
  getVideoDurationInFrames,
  getVideoDurationSeconds,
  parseVideoPresentationProject,
  VideoPresentationComposition,
  VideoPresentationPlayer,
} from "@sourceweft/video-presentation-runtime";
import { apiBaseUrl } from "../../../../../../lib/sdk";
import type { ArtifactPreviewRenderer } from "../types";

type RemotionWebRenderFormat = {
  container: "mp4" | "webm";
  extension: "mp4" | "webm";
  label: string;
  videoCodec: "h264" | "h265" | "vp8" | "vp9";
};

export function resolveVideoProjectStageLabel(
  payload: Record<string, unknown>,
) {
  const generation =
    payload.generation &&
    typeof payload.generation === "object" &&
    !Array.isArray(payload.generation)
      ? (payload.generation as Record<string, unknown>)
      : null;
  const stage = typeof generation?.stage === "string" ? generation.stage : null;
  if (stage === "failed") {
    return "Video project failed";
  }
  if (stage === "planning") {
    return "Planning video scenes";
  }
  if (stage === "generating_project_code") {
    return "Generating Remotion project code";
  }
  if (stage === "installing_project") {
    return "Installing project dependencies";
  }
  if (stage === "typechecking_project") {
    return "Typechecking generated project";
  }
  if (stage === "rendering_smoke_preview") {
    return "Rendering smoke preview";
  }
  if (stage === "planning_storyboard" || stage === "normalizing_blueprint") {
    return "Planning storyboard";
  }
  if (stage === "materializing_assets") {
    return "Preparing visual assets";
  }
  if (stage === "generating_audio_tracks") {
    return "Generating narration audio";
  }
  if (stage === "assigning_slide_themes") {
    return "Assigning visual themes";
  }
  if (stage === "generating_scene_modules") {
    return "Generating Remotion scene code";
  }
  if (stage === "repairing_scene_modules") {
    return "Repairing scene code";
  }
  if (stage === "publishing_video_project") {
    return "Finalizing video project";
  }
  if (stage === "ready") {
    return "Ready for browser video export";
  }
  return "Preparing video project";
}

export function isVideoPresentationFailed(input: {
  artifactStatus: string;
  payload: Record<string, unknown>;
}) {
  const generation =
    input.payload.generation &&
    typeof input.payload.generation === "object" &&
    !Array.isArray(input.payload.generation)
      ? (input.payload.generation as Record<string, unknown>)
      : null;
  return input.artifactStatus === "failed" || generation?.status === "failed";
}

function videoPresentationDownloadName(
  title: string,
  extension: "mp4" | "webm",
) {
  const normalized = title
    .normalize("NFKC")
    .trim()
    // eslint-disable-next-line no-control-regex -- strip filesystem control characters from downloads
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[\s.-]+|[\s.-]+$/g, "")
    .slice(0, 120);
  const fallback = normalized || "video-presentation";
  return fallback.toLowerCase().endsWith(`.${extension}`)
    ? fallback
    : `${fallback}.${extension}`;
}

async function chooseRemotionWebRenderFormat(): Promise<RemotionWebRenderFormat | null> {
  const { canRenderMediaOnWeb } = await import("@remotion/web-renderer");
  const candidates: RemotionWebRenderFormat[] = [
    { container: "mp4", extension: "mp4", label: "MP4", videoCodec: "h264" },
    { container: "mp4", extension: "mp4", label: "MP4", videoCodec: "h265" },
    { container: "webm", extension: "webm", label: "WebM", videoCodec: "vp9" },
    { container: "webm", extension: "webm", label: "WebM", videoCodec: "vp8" },
  ];
  for (const candidate of candidates) {
    const result = await canRenderMediaOnWeb({
      container: candidate.container,
      videoCodec: candidate.videoCodec,
      height: 1080,
      width: 1920,
    });
    if (result.canRender) {
      return candidate;
    }
  }
  return null;
}

async function renderVideoPresentationOnWeb(input: {
  format: RemotionWebRenderFormat;
  payload: VideoPresentationProjectPayload;
  scenes: CompiledVideoPresentationScene[];
  onProgress: (progress: number) => void;
  signal: AbortSignal;
}) {
  const { renderMediaOnWeb } = await import("@remotion/web-renderer");
  const { getBlob } = await renderMediaOnWeb({
    composition: {
      component: VideoPresentationComposition,
      durationInFrames: getVideoDurationInFrames(input.payload),
      fps: input.payload.project.fps,
      height: input.payload.project.height,
      id: "video-presentation",
      width: input.payload.project.width,
      defaultProps: { scenes: input.scenes },
    },
    container: input.format.container,
    inputProps: { scenes: input.scenes },
    onProgress: ({ progress }) => input.onProgress(progress),
    signal: input.signal,
    videoBitrate: "high",
    videoCodec: input.format.videoCodec,
  });
  return getBlob();
}

function resolveVideoPresentationAssetUrl(value: string) {
  return value.startsWith("/v1/") ? `${apiBaseUrl}${value}` : value;
}

export function canRenderVideoPresentationScenes(input: {
  compiledSceneCount: number;
  diagnosticCount: number;
  isCompilingScenes: boolean;
  isPreparing: boolean;
  sceneModuleCount: number;
  slideCount: number;
}) {
  return (
    !input.isPreparing &&
    !input.isCompilingScenes &&
    input.diagnosticCount === 0 &&
    input.sceneModuleCount === input.slideCount &&
    input.compiledSceneCount === input.slideCount
  );
}

function VideoPresentationPreview({
  artifactStatus,
  errorMessage,
  payload,
  title,
}: {
  artifactStatus: string;
  errorMessage?: string | null;
  payload: Record<string, unknown>;
  title: string;
}) {
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
  const [isRendering, setIsRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState<number | null>(null);
  const [renderFormat, setRenderFormat] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
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
      resolveAudioUrl: resolveVideoPresentationAssetUrl,
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
  }, [fallbackScenes, isFailed, project]);

  const handleDownloadVideo = useCallback(async () => {
    if (
      !project ||
      isRendering ||
      isCompilingScenes ||
      compileDiagnostics.length > 0 ||
      project.sceneModules.length !== project.slides.length ||
      compiledScenes.length !== project.slides.length
    ) {
      return;
    }

    setIsRendering(true);
    setRenderProgress(0);
    setRenderFormat(null);
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const format = await chooseRemotionWebRenderFormat();
      if (!format) {
        throw new Error(
          "Your browser does not support in-browser video rendering.",
        );
      }
      setRenderFormat(format.label);
      const blob = await renderVideoPresentationOnWeb({
        format,
        payload: project,
        scenes: compiledScenes,
        onProgress: setRenderProgress,
        signal: controller.signal,
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = videoPresentationDownloadName(title, format.extension);
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        toast.error("Video export failed", {
          description:
            error instanceof Error
              ? error.message
              : "Could not render this video in the browser.",
        });
      }
    } finally {
      setIsRendering(false);
      setRenderProgress(null);
      setRenderFormat(null);
      abortControllerRef.current = null;
    }
  }, [
    compileDiagnostics.length,
    compiledScenes,
    isCompilingScenes,
    isRendering,
    project,
    title,
  ]);

  const handleCancelRender = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

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
          {isRendering ? (
            <div className="flex items-center gap-2">
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
              <span className="text-[11px] font-medium text-muted-foreground">
                Rendering {renderFormat ?? "video"}{" "}
                {renderProgress !== null
                  ? `${Math.round(renderProgress * 100)}%`
                  : ""}
              </span>
              <Button
                className="h-7 px-2 text-[11px]"
                onClick={handleCancelRender}
                size="xs"
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              className="h-7 justify-center gap-1.5 px-3 text-[11px] shadow-sm sm:min-w-32"
              disabled={!canRenderPreparedScenes}
              onClick={() => void handleDownloadVideo()}
              size="xs"
              type="button"
            >
              <Video className="size-3.5" />
              Download Video
            </Button>
          )}
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

export const videoPresentationPreviewRenderer: ArtifactPreviewRenderer = {
  blocksDefaultDownload: true,
  blocksDefaultOpen: true,
  id: "video-presentation",
  match: ({ artifact }) => artifact.artifactType === "video_presentation",
  render: ({ artifact, payload, title }) => (
    <VideoPresentationPreview
      artifactStatus={artifact.status}
      errorMessage={artifact.errorMessage}
      payload={payload}
      title={title}
    />
  ),
};
