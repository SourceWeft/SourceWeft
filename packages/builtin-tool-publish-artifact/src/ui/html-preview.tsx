"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Code2,
  Copy,
  Download,
  Expand,
  Eye,
  ChevronLeft,
  ChevronRight,
  Grid2X2,
  Minimize2,
} from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { HTML_IFRAME_SANDBOX } from "@sourceweft/contracts/artifact-execution";
import {
  PRESENTATION_PROTOCOL,
  presentationEventSchema,
  type PresentationCapability,
  type PresentationState,
} from "@sourceweft/contracts/html-artifact";
import { ARTIFACT_LIMITS } from "@sourceweft/contracts/artifact-files";

export type HtmlPreviewFile = {
  fileName: string;
  role: string;
  url: string | null;
  downloadUrl?: string | null;
};

/** One renderer for every producer. No generation engine is imported here. */
export function HtmlPreview({
  fileUrl,
  downloadUrl,
  title,
  presentation,
  files = [],
}: {
  fileUrl: string;
  downloadUrl: string | null;
  title: string;
  presentation?: PresentationCapability;
  files?: readonly HtmlPreviewFile[];
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [source, setSource] = useState<string | null>(null);
  const sourceCache = useRef<{ url: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [state, setState] = useState<PresentationState | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const channelId = useMemo(() => crypto.randomUUID(), [fileUrl]);
  const sequence = useRef(0);
  const connected = useRef(false);
  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const handshakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadSource = useCallback(
    async (signal?: AbortSignal) => {
      if (sourceCache.current?.url === fileUrl) return sourceCache.current.text;
      const response = await fetch(fileUrl, {
        credentials: "same-origin",
        cache: "no-store",
        signal,
      });
      if (!response.ok)
        throw new Error(
          `Could not read HTML (${response.status}). Reload to check access and version.`,
        );
      const declaredSize = Number(response.headers.get("content-length"));
      if (declaredSize > ARTIFACT_LIMITS.htmlBytes)
        throw new Error("HTML exceeds the supported size.");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("The HTML response has no body.");
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > ARTIFACT_LIMITS.htmlBytes) {
            await reader.cancel();
            throw new Error("HTML exceeds the supported size.");
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!signal?.aborted) sourceCache.current = { url: fileUrl, text };
      return text;
    },
    [fileUrl],
  );

  useEffect(() => {
    setSource(null);
    setError(null);
    setCopied(false);
    setState(null);
    setConnectionError(null);
    sourceCache.current = null;
  }, [fileUrl]);

  useEffect(() => {
    const changed = () =>
      setIsFullscreen(document.fullscreenElement === stage.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);

  useEffect(() => {
    if (mode !== "source") return;
    const abort = new AbortController();
    void loadSource(abort.signal)
      .then((text) => {
        if (!abort.signal.aborted) setSource(text);
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted)
          setError(
            cause instanceof Error ? cause.message : "Could not read HTML",
          );
      });
    return () => abort.abort();
  }, [mode, loadSource]);

  useEffect(() => {
    if (!presentation) return;
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      try {
        if (JSON.stringify(event.data).length > 16_384) return;
      } catch {
        return;
      }
      const parsed = presentationEventSchema.safeParse(event.data);
      if (!parsed.success || parsed.data.channelId !== channelId) return;
      const data = parsed.data;
      if (data.type !== "ready" && !connected.current) return;
      if (data.type === "ack" || (data.type === "error" && data.requestId)) {
        const id = data.requestId!;
        const timer = pending.current.get(id);
        if (!timer) return;
        clearTimeout(timer);
        pending.current.delete(id);
      }
      if (data.type === "error") {
        setConnectionError(data.message);
        return;
      }
      if (data.state.slideCount !== presentation.pages.length) {
        setConnectionError(
          "Presentation page count does not match the published file.",
        );
        return;
      }
      if (data.type === "ready") {
        connected.current = true;
        if (handshakeTimer.current) clearTimeout(handshakeTimer.current);
        setConnectionError(null);
      }
      setState(data.state);
    };
    window.addEventListener("message", receive);
    return () => {
      connected.current = false;
      for (const timer of pending.current.values()) clearTimeout(timer);
      pending.current.clear();
      window.removeEventListener("message", receive);
      if (handshakeTimer.current) clearTimeout(handshakeTimer.current);
    };
  }, [channelId, presentation]);

  function connect() {
    if (!presentation) return;
    setState(null);
    connected.current = false;
    for (const timer of pending.current.values()) clearTimeout(timer);
    pending.current.clear();
    if (handshakeTimer.current) clearTimeout(handshakeTimer.current);
    handshakeTimer.current = setTimeout(
      () =>
        setConnectionError(
          "Presentation controls did not connect. The document's own controls remain available.",
        ),
      5000,
    );
    frame.current?.contentWindow?.postMessage(
      { protocol: PRESENTATION_PROTOCOL, type: "init", channelId },
      "*",
    );
  }

  function command(
    command: "next" | "prev" | "goto" | "overview",
    extra: Record<string, unknown> = {},
  ) {
    if (!state || connectionError) return;
    const requestId = String(++sequence.current);
    pending.current.set(
      requestId,
      setTimeout(() => {
        pending.current.delete(requestId);
        setConnectionError(
          "The presentation did not acknowledge the command. Use its own controls or reload.",
        );
      }, 5000),
    );
    frame.current?.contentWindow?.postMessage(
      {
        protocol: PRESENTATION_PROTOCOL,
        type: "command",
        channelId,
        requestId,
        command,
        ...extra,
      },
      "*",
    );
  }

  async function copySource() {
    try {
      await navigator.clipboard.writeText(await loadSource());
      setCopied(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not copy HTML");
    }
  }

  async function fullscreen() {
    try {
      if (document.fullscreenElement === stage.current) {
        await document.exitFullscreen();
        return;
      }
      if (!stage.current?.requestFullscreen)
        throw new Error("Fullscreen is not available in this browser.");
      await stage.current.requestFullscreen();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not enter fullscreen",
      );
    }
  }

  return (
    <div
      ref={stage}
      className="flex h-full min-h-80 w-full flex-col overflow-hidden bg-background text-foreground"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/20 px-3 py-2">
        <div className="flex items-center gap-1" aria-label="Document view">
          <Button
            size="sm"
            variant={mode === "preview" ? "secondary" : "ghost"}
            onClick={() => setMode("preview")}
            aria-pressed={mode === "preview"}
          >
            <Eye className="size-3.5" />
            Preview
          </Button>
          <Button
            size="sm"
            variant={mode === "source" ? "secondary" : "ghost"}
            onClick={() => setMode("source")}
            aria-pressed={mode === "source"}
          >
            <Code2 className="size-3.5" />
            Source
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void copySource()}
            aria-label="Copy HTML"
          >
            <Copy className="size-3.5" />
            {copied ? "Copied" : "Copy"}
          </Button>
          {downloadUrl && (
            <Button size="sm" variant="ghost" asChild>
              <a href={downloadUrl} aria-label="Download HTML">
                <Download className="size-3.5" />
                <span className="hidden sm:inline">Download</span>
              </a>
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => void fullscreen()}
            aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          >
            {isFullscreen ? (
              <Minimize2 className="size-3.5" />
            ) : (
              <Expand className="size-3.5" />
            )}
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="border-b px-4 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {connectionError && (
        <p
          role="alert"
          className="border-b px-4 py-2 text-xs text-muted-foreground"
        >
          {connectionError}
        </p>
      )}
      <div className="relative min-h-0 flex-1">
        <iframe
          key={fileUrl}
          ref={frame}
          title={title}
          src={fileUrl}
          sandbox={HTML_IFRAME_SANDBOX}
          allow="fullscreen"
          referrerPolicy="no-referrer"
          onLoad={connect}
          className={`h-full min-h-80 w-full border-0 ${mode === "source" ? "hidden" : ""}`}
        />
        {mode === "source" && (
          <div className="h-full overflow-auto bg-muted/10 p-4">
            {source === null ? (
              <p className="text-sm text-muted-foreground">Loading HTML…</p>
            ) : (
              <>
                {source.length > 1_000_000 && (
                  <p className="mb-3 text-xs text-muted-foreground">
                    Showing the first 1,000,000 characters. Copy and Download
                    include the complete file.
                  </p>
                )}
                <pre className="text-xs leading-6">
                  <code>{source.slice(0, 1_000_000)}</code>
                </pre>
              </>
            )}
          </div>
        )}
      </div>
      {presentation && state && !connectionError && mode === "preview" && (
        <div className="border-t bg-muted/20">
          <div className="flex items-center justify-center gap-3 px-3 py-2">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Previous page"
              onClick={() => command("prev")}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span
              className="min-w-16 text-center text-xs tabular-nums"
              aria-live="polite"
            >
              {state.slideIndex + 1} / {state.slideCount}
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Next page"
              onClick={() => command("next")}
            >
              <ChevronRight className="size-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Toggle overview"
              onClick={() => command("overview", { enabled: !state.overview })}
            >
              <Grid2X2 className="size-4" />
            </Button>
          </div>
          <div
            className="flex gap-2 overflow-x-auto px-3 pb-3"
            aria-label="Presentation pages"
          >
            {presentation.pages.map((page, index) => {
              const thumbnail = files.find(
                (file) => file.fileName === page.thumbnail,
              );
              return (
                <button
                  key={page.id}
                  type="button"
                  onClick={() => command("goto", { slideIndex: index })}
                  aria-label={`Go to page ${index + 1}`}
                  aria-current={index === state.slideIndex ? "page" : undefined}
                  className={`w-24 shrink-0 overflow-hidden rounded border text-left text-[10px] ${index === state.slideIndex ? "border-primary ring-1 ring-primary" : "border-border"}`}
                >
                  {thumbnail?.url && (
                    <img
                      src={thumbnail.url}
                      alt=""
                      className="aspect-video w-full object-cover"
                      loading="lazy"
                      onError={() =>
                        setConnectionError(
                          "A published page image could not be loaded. Reload to check access and version.",
                        )
                      }
                    />
                  )}
                  <span className="block truncate px-2 py-1.5">
                    {index + 1}. {page.title ?? `Page ${index + 1}`}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
