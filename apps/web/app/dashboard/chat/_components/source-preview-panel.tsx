"use client";

import { useEffect, useRef, useState } from "react";
import { FileText, Hash, Loader2, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { MessageResponse } from "@sourceweft/ui-web/components/ai-elements/message";
import { ScrollArea } from "@sourceweft/ui-web/components/ui/scroll-area";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { HttpClientError } from "@sourceweft/sdk";
import { contentClient } from "../../../../lib/sdk";
import type { CitationRecord } from "./chat-canvas";
import type { SourceItem } from "./mock-data";

type SourceDetail = Awaited<ReturnType<typeof contentClient.getSource>>;
type PreviewMode = "chunks" | "raw";

export function SourcePreviewPanel({
  citation,
  onOpenChange,
  open,
  source,
  workspaceId,
}: {
  citation?: CitationRecord | null;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  source?: SourceItem | null;
  workspaceId?: string | null;
}) {
  const [detail, setDetail] = useState<SourceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isDeletedCitation, setIsDeletedCitation] = useState(false);
  const [isHistoricalCitation, setIsHistoricalCitation] = useState(false);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("chunks");
  const scrollRootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      setPreviewMode("chunks");
    }
  }, [citation?.chunkId, open, source?.id]);

  useEffect(() => {
    if (!open || !workspaceId || (!citation && !source)) {
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setDetail(null);
    setIsDeletedCitation(false);
    setIsHistoricalCitation(false);

    const request = citation
      ? Promise.all([
          contentClient.getSourceDocument(
            workspaceId,
            citation.sourceId,
            citation.documentId,
          ),
          contentClient.getSource(workspaceId, citation.sourceId),
        ]).then(([detailResult, currentResult]) => ({
          detail: detailResult,
          isHistorical:
            currentResult.documents[0]?.id !== undefined &&
            currentResult.documents[0]?.id !== citation.documentId,
        }))
      : contentClient
          .getSource(workspaceId, source!.id)
          .then((detailResult) => ({
            detail: detailResult,
            isHistorical: false,
          }));

    request
      .then((result) => {
        if (!cancelled) {
          setDetail(result.detail);
          setIsHistoricalCitation(result.isHistorical);
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setDetail(null);
          if (
            citation &&
            loadError instanceof HttpClientError &&
            loadError.status === 404
          ) {
            setIsDeletedCitation(true);
            return;
          }

          setError(
            loadError instanceof Error
              ? loadError.message
              : "Failed to load source preview.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [citation, open, source, workspaceId]);

  useEffect(() => {
    if (!open || !detail || !citation) {
      return;
    }

    const timers = [80, 180, 360].map((delay) =>
      window.setTimeout(() => {
        const root = scrollRootRef.current;
        if (!root) {
          return;
        }

        const viewport = root.querySelector(
          "[data-slot='scroll-area-viewport']",
        ) as HTMLElement | null;
        const target = root.querySelector(
          `[data-source-chunk-id="${CSS.escape(citation.chunkId)}"]`,
        ) as HTMLElement | null;

        if (!viewport || !target) {
          return;
        }

        const viewportRect = viewport.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const targetTop =
          targetRect.top - viewportRect.top + viewport.scrollTop;
        viewport.scrollTo({
          behavior: delay === 80 ? "auto" : "smooth",
          top: Math.max(0, targetTop - viewportRect.height * 0.2),
        });
      }, delay),
    );

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [citation, detail, open]);

  const citedChunk = detail?.chunks.find(
    (chunk) => chunk.id === citation?.chunkId,
  );
  const rawMarkdown =
    detail?.documents[0]?.contentText ?? detail?.source.contentText ?? "";
  const title =
    detail?.source.title ?? citation?.sourceTitle ?? source?.title ?? "Source";

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="flex h-[min(900px,calc(100vh-3rem))] w-[min(1120px,calc(100vw-2rem))] max-w-none flex-col overflow-hidden p-0"
        constrainWidth={false}
      >
        <DialogHeader className="border-b bg-muted/30 px-5 py-4">
          <div className="flex min-w-0 items-start justify-between gap-4 pr-9">
            <div className="min-w-0">
              <DialogTitle className="truncate text-lg font-semibold">
                {title}
              </DialogTitle>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5">
                  <Hash className="size-3" />
                  {typeof citation?.chunkNo === "number"
                    ? `Chunk ${citation.chunkNo + 1}`
                    : citation
                      ? "Cited chunk"
                      : "Source preview"}
                </span>
                {detail?.chunks ? (
                  <span>{detail.chunks.length} chunks</span>
                ) : null}
                {detail?.source.mimeType ? (
                  <span>{detail.source.mimeType}</span>
                ) : null}
                {isHistoricalCitation ? (
                  <span className="inline-flex items-center rounded-full border border-amber-300/70 bg-amber-100/80 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-200">
                    Historical
                  </span>
                ) : null}
                {isDeletedCitation ? (
                  <span className="inline-flex items-center rounded-full border border-slate-300/70 bg-slate-100/80 px-2 py-0.5 text-[10px] font-medium text-slate-700 dark:border-slate-500/30 dark:bg-slate-500/15 dark:text-slate-200">
                    Source deleted
                  </span>
                ) : null}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {detail ? (
                <div className="flex rounded-lg border bg-background p-0.5">
                  <button
                    className={cn(
                      "rounded-md px-2 py-1 text-xs font-medium transition-colors",
                      previewMode === "chunks"
                        ? "bg-secondary text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => setPreviewMode("chunks")}
                    type="button"
                  >
                    Chunks
                  </button>
                  <button
                    className={cn(
                      "rounded-md px-2 py-1 text-xs font-medium transition-colors",
                      previewMode === "raw"
                        ? "bg-secondary text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => setPreviewMode("raw")}
                    type="button"
                  >
                    Raw MD
                  </button>
                </div>
              ) : null}
              {previewMode === "chunks" && citedChunk ? (
                <Button
                  className="hidden shrink-0 gap-1.5 md:inline-flex"
                  onClick={() => {
                    const target = scrollRootRef.current?.querySelector(
                      `[data-source-chunk-id="${CSS.escape(citedChunk.id)}"]`,
                    ) as HTMLElement | null;
                    target?.scrollIntoView({
                      behavior: "smooth",
                      block: "center",
                    });
                  }}
                  size="xs"
                  type="button"
                  variant="outline"
                >
                  <Sparkles className="size-3.5" />
                  Jump to cited
                </Button>
              ) : null}
            </div>
          </div>
        </DialogHeader>

        {isLoading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            Loading source preview...
          </div>
        ) : isDeletedCitation && citation ? (
          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto flex min-h-full max-w-4xl flex-col justify-center space-y-4 px-5 py-6 lg:px-8">
              <div className="rounded-2xl border border-dashed bg-muted/20 px-5 py-4 text-sm text-muted-foreground">
                <div className="mb-2 flex items-center gap-2 font-medium text-foreground">
                  <FileText className="size-4" />
                  Source no longer available
                </div>
                The original source was deleted, so only the citation snapshot
                saved with this answer can be shown.
              </div>

              <article className="overflow-hidden rounded-2xl border bg-background shadow-xs">
                <div className="flex items-center justify-between border-b bg-muted/25 px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                      <Hash className="size-3.5" />
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">
                        {citation.sourceTitle?.trim() || "Deleted source"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {typeof citation.chunkNo === "number"
                          ? `Chunk ${citation.chunkNo + 1}`
                          : "Cited chunk"}
                      </div>
                    </div>
                  </div>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
                    <Sparkles className="size-3.5" />
                    Preserved citation
                  </span>
                </div>
                <div className="px-4 py-4 lg:px-5">
                  <MessageResponse className="text-sm leading-7 text-foreground [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:px-3 [&_td]:py-2 [&_th]:border [&_th]:bg-muted/40 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left">
                    {citation.excerpt || "No citation excerpt was saved."}
                  </MessageResponse>
                </div>
              </article>
            </div>
          </ScrollArea>
        ) : error ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-destructive">
            {error}
          </div>
        ) : detail ? (
          previewMode === "raw" ? (
            <ScrollArea className="min-h-0 flex-1">
              <pre className="mx-auto min-h-full max-w-5xl whitespace-pre-wrap break-words px-5 py-6 font-mono text-xs leading-6 text-foreground lg:px-8">
                {rawMarkdown || "No markdown content available."}
              </pre>
            </ScrollArea>
          ) : (
            <div className="flex min-h-0 flex-1 overflow-hidden">
              {detail.chunks.length > 1 ? (
                <aside className="hidden w-16 shrink-0 border-r bg-muted/15 p-2 lg:block">
                  <ScrollArea className="h-full">
                    <div className="flex flex-col gap-1.5">
                      {detail.chunks.map((chunk, index) => {
                        const isCited = chunk.id === citation?.chunkId;
                        return (
                          <button
                            className={cn(
                              "relative mx-auto flex h-9 w-10 items-center justify-center rounded-lg text-xs font-semibold transition-colors",
                              isCited
                                ? "bg-primary text-primary-foreground shadow-sm"
                                : "bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
                            )}
                            key={chunk.id}
                            onClick={() => {
                              const target =
                                scrollRootRef.current?.querySelector(
                                  `[data-source-chunk-id="${CSS.escape(chunk.id)}"]`,
                                ) as HTMLElement | null;
                              target?.scrollIntoView({
                                behavior: "smooth",
                                block: "center",
                              });
                            }}
                            title={`Chunk ${index + 1}`}
                            type="button"
                          >
                            {index + 1}
                            {isCited ? (
                              <span className="absolute -right-1 -top-1 rounded-full bg-primary ring-2 ring-background">
                                <Sparkles className="size-3 text-primary-foreground" />
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </ScrollArea>
                </aside>
              ) : null}

              <ScrollArea className="min-w-0 flex-1" ref={scrollRootRef}>
                <div className="mx-auto max-w-4xl space-y-4 px-5 py-6 lg:px-8">
                  {detail.chunks.map((chunk, index) => {
                    const isCited = chunk.id === citation?.chunkId;
                    return (
                      <article
                        className={cn(
                          "overflow-hidden rounded-2xl border bg-background shadow-xs transition-colors",
                          isCited &&
                            "border-primary/50 bg-primary/5 shadow-md shadow-primary/10",
                        )}
                        data-source-chunk-id={chunk.id}
                        key={chunk.id}
                      >
                        <div className="flex items-center justify-between border-b bg-muted/25 px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <span
                              className={cn(
                                "inline-flex h-7 min-w-7 items-center justify-center rounded-full text-xs font-semibold",
                                isCited
                                  ? "bg-primary text-primary-foreground"
                                  : "bg-muted text-muted-foreground",
                              )}
                            >
                              {index + 1}
                            </span>
                            <span className="text-sm font-medium text-foreground">
                              Chunk {index + 1}
                            </span>
                          </div>
                          {isCited ? (
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
                              <Sparkles className="size-3.5" />
                              Cited source
                            </span>
                          ) : null}
                        </div>
                        <div className="px-4 py-4 lg:px-5">
                          <MessageResponse className="text-sm leading-7 text-foreground [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:px-3 [&_td]:py-2 [&_th]:border [&_th]:bg-muted/40 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left">
                            {chunk.content}
                          </MessageResponse>
                        </div>
                      </article>
                    );
                  })}

                  {detail.chunks.length === 0 ? (
                    <div className="rounded-2xl border border-dashed bg-muted/20 px-5 py-10 text-center text-sm text-muted-foreground">
                      <FileText className="mx-auto mb-2 size-5" />
                      This source has no indexed chunks yet.
                    </div>
                  ) : null}
                </div>
              </ScrollArea>
            </div>
          )
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
