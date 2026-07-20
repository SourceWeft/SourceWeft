"use client";

/**
 * The visual HTML deck preview: a self-contained deck rendered in a sandboxed
 * iframe, with this capability's browser-side export actions above it.
 *
 * NOTE: unreachable today — nothing on the write side stores
 * `generationMode: "visual_html"` in a slides payload. Carried over verbatim
 * from the app-owned version; removing it is a separate decision.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { FileCode2, FileType2, Loader2, Video } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  exportVisualDeckEditablePptx,
  exportVisualDeckHtml,
  exportVisualDeckPptx,
  exportVisualDeckVideo,
} from "../visual-deck/browser";
import { resolveVisualDeckExportProfile } from "../visual-deck/profile";

const VISUAL_DECK_CONTROLS_HEIGHT = 48;
const VIDEO_EXPORT_SECONDS_PER_SLIDE = 2;
const VIDEO_EXPORT_TRANSITION_SECONDS = 0.3;

export function VisualHtmlDeckPreview({
  payload,
  previewUrl,
  title,
}: {
  payload: Record<string, unknown>;
  previewUrl: string;
  title: string;
}) {
  const profile = resolveVisualDeckExportProfile(payload);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [exportingHtml, setExportingHtml] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportingEditable, setExportingEditable] = useState(false);
  const [exportingVideo, setExportingVideo] = useState(false);
  const [frameHeight, setFrameHeight] = useState<number | null>(null);
  const [isFrameLoading, setIsFrameLoading] = useState(true);
  const isExportingAny =
    exporting || exportingEditable || exportingHtml || exportingVideo;
  const previewRatio = profile.slideSize.widthPx / profile.slideSize.heightPx;

  useEffect(() => {
    setIsFrameLoading(true);
  }, [previewUrl]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const handleResize = () => {
      const width = container.clientWidth;
      if (width > 0) {
        setFrameHeight(
          Math.round(width / previewRatio + VISUAL_DECK_CONTROLS_HEIGHT),
        );
      }
    };

    const observer = new ResizeObserver(handleResize);
    observer.observe(container);
    handleResize();
    return () => {
      observer.disconnect();
    };
  }, [previewRatio]);

  const handleExportPptx = useCallback(async () => {
    setExporting(true);
    try {
      await exportVisualDeckPptx({
        fileUrl: previewUrl,
        payload,
        title,
      });
      toast.success("Visual PPTX export started.");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not export this deck as a visual PPTX.",
      );
    } finally {
      setExporting(false);
    }
  }, [payload, previewUrl, title]);

  const handleExportHtml = useCallback(async () => {
    setExportingHtml(true);
    try {
      await exportVisualDeckHtml({ fileUrl: previewUrl, title });
      toast.success("HTML export started.");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not export this deck as HTML.",
      );
    } finally {
      setExportingHtml(false);
    }
  }, [previewUrl, title]);

  const handleExportEditablePptx = useCallback(async () => {
    setExportingEditable(true);
    try {
      await exportVisualDeckEditablePptx({
        fileUrl: previewUrl,
        payload,
        title,
      });
      toast.success("Editable PPTX export started.");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not export this deck as an editable PPTX.",
      );
    } finally {
      setExportingEditable(false);
    }
  }, [payload, previewUrl, title]);

  const handleExportVideo = useCallback(async () => {
    setExportingVideo(true);
    try {
      const videoFormat = await exportVisualDeckVideo({
        fileUrl: previewUrl,
        narrationEnabled: false,
        payload,
        secondsPerSlide: VIDEO_EXPORT_SECONDS_PER_SLIDE,
        title,
        transitionSeconds: VIDEO_EXPORT_TRANSITION_SECONDS,
      });
      toast.success(`${videoFormat.label} export started.`);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not export this deck as video.",
      );
    } finally {
      setExportingVideo(false);
    }
  }, [payload, previewUrl, title]);

  return (
    <div className="space-y-3">
      <div className="w-full overflow-hidden rounded-xl border bg-background shadow-sm">
        <div className="grid gap-2 border-b px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="min-w-0 pr-2">
            <p className="whitespace-nowrap text-xs font-medium text-foreground">
              Deck Preview
            </p>
          </div>
          <div className="flex w-full flex-col gap-1.5 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
            <div className="grid grid-cols-3 overflow-hidden rounded-md border bg-muted/20 sm:flex">
              <Button
                className="h-7 justify-center gap-1.5 rounded-none border-r px-2.5 text-[11px]"
                disabled={isExportingAny}
                onClick={handleExportHtml}
                size="xs"
                type="button"
                variant="ghost"
              >
                {exportingHtml ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <FileCode2 className="size-3.5" />
                )}
                HTML
              </Button>
              <Button
                className="h-7 justify-center gap-1.5 rounded-none border-r px-2.5 text-[11px]"
                disabled={isExportingAny}
                onClick={handleExportEditablePptx}
                size="xs"
                title="Download an editable PowerPoint version"
                type="button"
                variant="ghost"
              >
                {exportingEditable ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <FileType2 className="size-3.5" />
                )}
                Editable
              </Button>
              <Button
                className="h-7 justify-center gap-1.5 rounded-none px-2.5 text-[11px]"
                disabled={isExportingAny}
                onClick={handleExportVideo}
                size="xs"
                type="button"
                variant="ghost"
              >
                {exportingVideo ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Video className="size-3.5" />
                )}
                Video
              </Button>
            </div>
            <Button
              className="h-7 justify-center gap-1.5 px-3 text-[11px] shadow-sm sm:min-w-28"
              disabled={isExportingAny}
              onClick={handleExportPptx}
              size="xs"
              type="button"
            >
              {exporting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <FileType2 className="size-3.5" />
              )}
              Visual PPTX
            </Button>
          </div>
        </div>
        <div
          className="relative w-full overflow-hidden bg-[#0b1017]"
          ref={containerRef}
          style={
            frameHeight
              ? { height: `${frameHeight}px` }
              : { aspectRatio: `${profile.slideSize.widthPx} / ${profile.slideSize.heightPx}` }
          }
        >
          {isFrameLoading ? (
            <div className="absolute inset-0 z-10 grid place-items-center bg-background/70">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : null}
          <iframe
            key={previewUrl}
            className="block h-full w-full border-0 bg-[#0b1017]"
            onLoad={() => {
              setIsFrameLoading(false);
            }}
            sandbox="allow-scripts"
            src={previewUrl}
            title={`${title} preview`}
          />
        </div>
      </div>
    </div>
  );
}
