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

/**
 * pptxviewjs measures the canvas's box (`getBoundingClientRect`) to fit the
 * slide, then pins that size back as inline `style.width/height`. Those pinned
 * values then win over our CSS and freeze the size, so a later resize (e.g.
 * entering fullscreen) never re-fits. Clearing them before each (re-)render lets
 * it re-measure the real container box — it fits the slide and centers it with
 * `backgroundColor` letterbox on its own.
 */
function resetCanvasInlineSize(canvas: HTMLCanvasElement) {
  canvas.style.width = "";
  canvas.style.height = "";
}

export function PptxViewJsPreview({
  fileUrl,
  title,
  fill = false,
  className,
  keyboardNav = false,
  controls = "bar",
}: {
  fileUrl: string;
  title: string;
  /**
   * Fill the parent instead of sitting as a fixed card. The in-app panel leaves
   * this off (a self-sized card); the full-page public share page turns it on so
   * the same component stretches edge to edge — one preview, CSS per surface.
   */
  fill?: boolean;
  className?: string;
  /** Page slides with ←/→ (and PageUp/Down). Enabled by the host in fullscreen. */
  keyboardNav?: boolean;
  /**
   * Where the paging controls live. `"bar"` (default, in-app panel) draws a
   * titled header strip with the counter and buttons. `"overlay"` (full-page /
   * immersive) drops the chrome entirely and floats two translucent chevrons
   * over the slide with a subtle counter — cleaner when the deck is the page.
   */
  controls?: "bar" | "overlay";
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
        resetCanvasInlineSize(canvas);
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

  // Re-render the current slide when the canvas is resized (entering/leaving
  // fullscreen, window resize) so it renders at the new pixel size instead of
  // upscaling a smaller bitmap — keeps it sharp at any size. Uses the same
  // `goToSlide` API as paging; guarded against pre-load fires and sub-pixel
  // jitter so it can't loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    // Observe the CONTAINER, not the canvas: pptxviewjs pins the canvas's inline
    // size, so the canvas itself doesn't report the resize — its box only tracks
    // the container once we clear that pin (below) and re-render.
    const container = canvas?.parentElement;
    if (!canvas || !container || typeof ResizeObserver === "undefined") {
      return;
    }
    let frame = 0;
    let lastWidth = 0;
    let lastHeight = 0;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      const width = rect?.width ?? 0;
      const height = rect?.height ?? 0;
      if (
        width === 0 ||
        (Math.abs(width - lastWidth) < 24 && Math.abs(height - lastHeight) < 24)
      ) {
        return;
      }
      lastWidth = width;
      lastHeight = height;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const viewer = viewerRef.current;
        if (viewer) {
          resetCanvasInlineSize(canvas);
          void viewer.goToSlide(viewer.getCurrentSlideIndex(), canvas);
        }
      });
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

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
    resetCanvasInlineSize(canvas);
    await viewer.goToSlide(nextIndex, canvas);
    setCurrentSlide(viewer.getCurrentSlideIndex());
  };

  // Arrow-key paging, opt-in via `keyboardNav` (the host turns it on when this
  // preview is the sole focus — e.g. fullscreen — so it never hijacks page keys
  // while embedded in a panel).
  useEffect(() => {
    if (!keyboardNav) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        void goToSlide(1);
      } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        void goToSlide(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // `goToSlide` closes over the latest slide state each render, so re-binding
    // per render keeps the handler current.
  }, [keyboardNav, goToSlide]);

  if (error) {
    return (
      <SlidesFallback
        detail={`Preview renderer failed: ${error}. You can still open or download the PowerPoint.`}
      />
    );
  }

  if (controls === "overlay") {
    const atStart = currentSlide <= 0;
    const atEnd = currentSlide >= slideCount - 1;
    return (
      <div
        className={`absolute inset-0 overflow-hidden${
          className ? ` ${className}` : ""
        }`}
      >
        {/* The canvas box is the whole container (via `inset-0`, which fills the
            used size even where percentage height collapses — e.g. the native
            fullscreen top layer). pptxviewjs then fits the slide into that box
            and centers it, letterboxing the rest with its backgroundColor. */}
        <canvas
          className="absolute inset-0 h-full w-full"
          ref={canvasRef}
          title={`${title} preview canvas`}
        />
        {loading ? (
          <div className="absolute inset-0 z-10 grid place-items-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : null}
        {slideCount > 1 ? (
          <>
            <button
              className="absolute left-3 top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-black/25 text-white/90 backdrop-blur-sm transition hover:bg-black/45 disabled:pointer-events-none disabled:opacity-0"
              disabled={loading || atStart}
              onClick={() => void goToSlide(-1)}
              title="Previous slide"
              type="button"
            >
              <ChevronLeft className="size-5" />
              <span className="sr-only">Previous slide</span>
            </button>
            <button
              className="absolute right-3 top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-black/25 text-white/90 backdrop-blur-sm transition hover:bg-black/45 disabled:pointer-events-none disabled:opacity-0"
              disabled={loading || atEnd}
              onClick={() => void goToSlide(1)}
              title="Next slide"
              type="button"
            >
              <ChevronRight className="size-5" />
              <span className="sr-only">Next slide</span>
            </button>
            <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/45 px-2.5 py-0.5 text-[11px] font-medium text-white/90 backdrop-blur-sm">
              {currentSlide + 1} / {slideCount}
            </div>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={`overflow-hidden rounded-xl border bg-background shadow-sm${
        fill ? " flex h-full flex-col" : ""
      }${className ? ` ${className}` : ""}`}
    >
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
      <div
        className={`relative flex items-center justify-center bg-muted/40 p-3${
          fill ? " min-h-0 flex-1" : " min-h-80"
        }`}
      >
        {loading ? (
          <div className="absolute inset-0 z-10 grid place-items-center bg-background/70">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : null}
        <canvas
          className={`rounded-md bg-white shadow-sm${
            fill
              ? " h-full w-full object-contain"
              : " h-auto w-full max-w-[calc((100vh-15rem)*16/9)]"
          }`}
          ref={canvasRef}
          title={`${title} preview canvas`}
        />
      </div>
    </div>
  );
}
