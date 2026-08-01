"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Maximize2, X } from "lucide-react";
import type { PublicSharedArtifactResponse } from "@sourceweft/contracts";
import { PptxViewJsPreview } from "@sourceweft/builtin-tool-publish-artifact/ui";
import { RawImage } from "../../_components/raw-image";

type SharedArtifact = PublicSharedArtifactResponse["artifact"];

/**
 * Public share viewer chrome (header + content + footer) with an immersive
 * fullscreen mode that hides the header/footer and shows only the artifact.
 *
 * Fullscreen uses the native Fullscreen API on the stage element — real
 * whole-browser fullscreen — and falls back to a CSS overlay only when the
 * browser can't do element fullscreen (e.g. iOS Safari). The stage stays mounted
 * across the toggle, so entering fullscreen never re-fetches or re-parses.
 *
 * Per-format interaction lives in the format's own preview: slides render with
 * `controls="overlay"` (floating chevrons, no chrome) and get arrow-key paging
 * while immersive. New formats slot into the same branch without touching this
 * shell.
 */
export function SharedArtifactViewer({
  artifact,
}: {
  artifact: SharedArtifact;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [overlayFullscreen, setOverlayFullscreen] = useState(false);
  const immersive = nativeFullscreen || overlayFullscreen;
  const title = artifact.title || "Shared artifact";

  const isSlides =
    artifact.artifactType === "slides" && Boolean(artifact.fileUrl);
  const canInlineEmbed =
    Boolean(artifact.fileUrl) && artifact.inlinePreviewable;
  const hasVisual =
    isSlides || canInlineEmbed || Boolean(artifact.previewImageUrl);

  // Track the browser's own fullscreen state so Esc / F11 / the OS control keep
  // our UI in sync.
  useEffect(() => {
    const onChange = () =>
      setNativeFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Fallback path only (no native fullscreen): Esc exits, body scroll locked.
  useEffect(() => {
    if (!overlayFullscreen) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOverlayFullscreen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [overlayFullscreen]);

  const enterFullscreen = useCallback(() => {
    const stage = stageRef.current;
    if (stage?.requestFullscreen) {
      stage.requestFullscreen().catch(() => setOverlayFullscreen(true));
    } else {
      setOverlayFullscreen(true);
    }
  }, []);

  const exitFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    }
    setOverlayFullscreen(false);
  }, []);

  const preview =
    isSlides && artifact.fileUrl ? (
      <PptxViewJsPreview
        className="h-full w-full"
        controls="overlay"
        fileUrl={artifact.fileUrl}
        fill
        keyboardNav={immersive}
        title={title}
      />
    ) : canInlineEmbed && artifact.fileUrl ? (
      // Sandboxed + cross-checked by the /raw endpoint's `CSP: sandbox` header:
      // the artifact runs in an opaque origin and cannot reach this page.
      <iframe
        title={title}
        src={artifact.fileUrl}
        className="h-full w-full border-0"
        sandbox="allow-scripts allow-popups allow-forms allow-modals"
      />
    ) : artifact.previewImageUrl ? (
      <div className="flex h-full flex-col items-center justify-center overflow-auto p-6">
        <RawImage
          alt={title}
          src={artifact.previewImageUrl}
          className="max-h-full max-w-full rounded-lg border object-contain shadow-sm"
        />
      </div>
    ) : artifact.fileUrl ? (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        This file can’t be previewed in the browser — use Download above.
      </div>
    ) : (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        Nothing to preview.
      </div>
    );

  return (
    <main className="flex min-h-dvh flex-col bg-background">
      <header
        className={`items-center justify-between gap-3 border-b px-4 py-2.5 ${
          immersive ? "hidden" : "flex"
        }`}
      >
        <span className="truncate text-sm font-medium">{title}</span>
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          {hasVisual ? (
            <button
              className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={enterFullscreen}
              title="Fullscreen"
              type="button"
            >
              <Maximize2 className="size-3.5" />
              Fullscreen
            </button>
          ) : null}
          {artifact.fileUrl ? (
            <a
              className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              href={artifact.fileUrl}
              rel="noopener"
              title="Download"
            >
              <Download className="size-3.5" />
              Download
            </a>
          ) : null}
          <span className="text-xs text-muted-foreground">
            {artifact.viewCount} {artifact.viewCount === 1 ? "view" : "views"}
          </span>
        </div>
      </header>

      <div
        ref={stageRef}
        className={`relative bg-background ${
          overlayFullscreen
            ? "fixed inset-0 z-50"
            : nativeFullscreen
              ? // In the native-fullscreen top layer the stage is no longer a
                // flex child, so `flex-1` gives no height and `h-full` children
                // collapse. Pin an explicit viewport box so any preview fills.
                "h-screen w-screen"
              : "min-h-0 flex-1"
        }`}
      >
        {immersive ? (
          <button
            className="absolute right-3 top-3 z-20 grid size-9 place-items-center rounded-full bg-black/25 text-white/90 backdrop-blur-sm transition hover:bg-black/45"
            onClick={exitFullscreen}
            title="Exit fullscreen (Esc)"
            type="button"
          >
            <X className="size-4" />
            <span className="sr-only">Exit fullscreen</span>
          </button>
        ) : null}
        {/* Fill via absolute inset, not `h-full`: an abs box takes the stage's
            used size directly, so it works even where percentage-height
            collapses (the native-fullscreen top layer). Same for every preview
            type — iframe or canvas. */}
        <div className="absolute inset-0">{preview}</div>
      </div>

      <footer
        className={`border-t px-4 py-2 text-center ${immersive ? "hidden" : ""}`}
      >
        <a
          className="text-xs text-muted-foreground hover:text-foreground"
          href="/"
          rel="noopener"
        >
          Made with <span className="font-medium">SourceWeft</span>
        </a>
      </footer>
    </main>
  );
}
