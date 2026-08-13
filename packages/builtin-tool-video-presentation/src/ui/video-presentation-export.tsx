"use client";

/**
 * Browser-side export: turning an already-compiled video project into a file on
 * the user's disk.
 *
 * The split from the previewer is along what the two actually do, not along
 * where their JSX lands. The previewer *reads* the project — it compiles scene
 * modules and mounts a Player, and everything it touches is Remotion's
 * rendering surface. The exporter *writes* a file — it negotiates a container
 * and codec the browser can actually encode, drives `renderMediaOnWeb` to
 * completion (with progress and cancellation), and names the download. It needs
 * exactly three things from the previewer (payload, compiled scenes, and
 * whether the project is complete enough to be worth exporting) and gives
 * nothing back, so the dependency runs one way and the codec table never has to
 * be reasoned about while reading the preview.
 */
import { useCallback, useRef, useState } from "react";
import { Loader2, TriangleAlert, Video } from "lucide-react";
import { toast } from "sonner";
import type { VideoPresentationProjectPayload } from "@sourceweft/contracts/video-presentation";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  getVideoDurationInFrames,
  VideoPresentationComposition,
  type CompiledVideoPresentationScene,
} from "@sourceweft/video-presentation-runtime";

type RemotionWebRenderFormat = {
  container: "mp4" | "webm";
  extension: "mp4" | "webm";
  label: string;
  videoCodec: "h264" | "h265" | "vp8" | "vp9";
};

/**
 * Preference order for in-browser encoding. Browsers disagree about which
 * codecs `WebCodecs` will actually encode, so the first candidate the running
 * browser accepts wins rather than a build-time choice.
 */
const REMOTION_WEB_RENDER_FORMATS: readonly RemotionWebRenderFormat[] = [
  { container: "mp4", extension: "mp4", label: "MP4", videoCodec: "h264" },
  { container: "mp4", extension: "mp4", label: "MP4", videoCodec: "h265" },
  { container: "webm", extension: "webm", label: "WebM", videoCodec: "vp9" },
  { container: "webm", extension: "webm", label: "WebM", videoCodec: "vp8" },
];

export function videoPresentationDownloadName(
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
  for (const candidate of REMOTION_WEB_RENDER_FORMATS) {
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

export type VideoPresentationExportControlsProps = {
  /** False while the project is incomplete — export would produce a broken file. */
  canExport: boolean;
  payload: VideoPresentationProjectPayload | null;
  scenes: CompiledVideoPresentationScene[];
  title: string;
};

export function VideoPresentationExportControls({
  canExport,
  payload,
  scenes,
  title,
}: VideoPresentationExportControlsProps) {
  const [isRendering, setIsRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState<number | null>(null);
  const [renderFormat, setRenderFormat] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const handleDownloadVideo = useCallback(async () => {
    if (!payload || !canExport || isRendering) {
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
        payload,
        scenes,
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
  }, [canExport, isRendering, payload, scenes, title]);

  const handleCancelRender = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  if (isRendering) {
    return (
      <div className="flex flex-col items-end gap-1.5">
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
        <p className="flex items-center gap-1 text-right text-[11px] leading-4 text-muted-foreground">
          <TriangleAlert className="size-3.5 shrink-0 text-amber-500" />
          Closing, refreshing, or leaving this page cancels the render.
        </p>
      </div>
    );
  }

  return (
    <Button
      className="h-7 justify-center gap-1.5 px-3 text-[11px] shadow-sm sm:min-w-32"
      disabled={!canExport}
      onClick={() => void handleDownloadVideo()}
      size="xs"
      type="button"
    >
      <Video className="size-3.5" />
      Download Video
    </Button>
  );
}
