"use client";

/**
 * The editable-PowerPoint preview: the published `.pptx` drawn slide by slide
 * in the browser.
 *
 * Which stored decks land here is decided in `./slides-preview`; this file only
 * knows how to draw one.
 */
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { SlidesFallback } from "./slides-fallback";

export function PptxViewJsPreview({
  fileUrl,
  title,
}: {
  fileUrl: string;
  title: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<import("pptxviewjs").PPTXViewer | null>(null);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [slideCount, setSlideCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const [{ PPTXViewer }, response] = await Promise.all([
          import("pptxviewjs"),
          fetch(fileUrl, { credentials: "include" }),
        ]);
        if (!response.ok) {
          throw new Error("Could not load the PPTX file.");
        }
        const buffer = await response.arrayBuffer();
        if (cancelled) {
          return;
        }
        const viewer = new PPTXViewer({
          backgroundColor: "#ffffff",
          canvas,
          slideSizeMode: "fit",
        });
        await viewer.loadFile(buffer);
        if (cancelled) {
          viewer.destroy();
          return;
        }
        await viewer.render(canvas, { quality: "high" });
        if (cancelled) {
          viewer.destroy();
          return;
        }
        viewerRef.current?.destroy();
        viewerRef.current = viewer;
        setSlideCount(viewer.getSlideCount());
        setCurrentSlide(viewer.getCurrentSlideIndex());
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "PPTX preview failed to load.",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
      viewerRef.current?.destroy();
      viewerRef.current = null;
    };
  }, [fileUrl]);

  const goToSlide = async (direction: -1 | 1) => {
    const viewer = viewerRef.current;
    const canvas = canvasRef.current;
    if (!viewer || !canvas) {
      return;
    }
    const nextIndex = Math.max(
      0,
      Math.min(slideCount - 1, currentSlide + direction),
    );
    await viewer.goToSlide(nextIndex, canvas);
    setCurrentSlide(viewer.getCurrentSlideIndex());
  };

  if (error) {
    return (
      <SlidesFallback
        detail={`Preview renderer failed: ${error}. You can still open or download the PowerPoint.`}
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-background shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-foreground">
            Editable PowerPoint
          </p>
          <p className="text-[11px] text-muted-foreground">
            {slideCount > 0
              ? `Slide ${currentSlide + 1} of ${slideCount}`
              : "Loading preview"}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            disabled={loading || currentSlide <= 0}
            onClick={() => void goToSlide(-1)}
            size="icon-xs"
            title="Previous slide"
            type="button"
            variant="ghost"
          >
            <ChevronLeft className="size-3.5" />
            <span className="sr-only">Previous slide</span>
          </Button>
          <Button
            disabled={loading || currentSlide >= slideCount - 1}
            onClick={() => void goToSlide(1)}
            size="icon-xs"
            title="Next slide"
            type="button"
            variant="ghost"
          >
            <ChevronRight className="size-3.5" />
            <span className="sr-only">Next slide</span>
          </Button>
        </div>
      </div>
      <div className="relative flex min-h-80 items-center justify-center bg-muted/40 p-3">
        {loading ? (
          <div className="absolute inset-0 z-10 grid place-items-center bg-background/70">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : null}
        <canvas
          className="h-auto w-full max-w-[calc((100vh-15rem)*16/9)] rounded-md bg-white shadow-sm"
          ref={canvasRef}
          title={`${title} preview canvas`}
        />
      </div>
    </div>
  );
}
