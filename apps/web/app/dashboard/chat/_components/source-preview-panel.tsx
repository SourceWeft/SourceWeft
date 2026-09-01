"use client";

import { useEffect, useRef, useState } from "react";
import {
  Code2,
  Download,
  ExternalLink,
  FileText,
  Hash,
  Loader2,
  PanelTopOpen,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { MessageResponse } from "@sourceweft/ui-web/components/ai-elements/message";
import { ScrollArea } from "@sourceweft/ui-web/components/ui/scroll-area";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@sourceweft/ui-web/components/ui/tabs";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { HttpClientError } from "@sourceweft/sdk";
import { contentClient } from "../../../../lib/sdk";
import { RawImage } from "../../../_components/raw-image";
import type { CitationRecord } from "./chat-canvas";
import type { SourceItem } from "./source-types";

type SourceDetail = Awaited<ReturnType<typeof contentClient.getSource>>;
type PreviewMode = "chunks" | "preview" | "raw" | "source-file";

const PREVIEW_MODE_OPTIONS: Array<{
  value: PreviewMode;
  label: string;
  icon: LucideIcon;
}> = [
  { value: "preview", label: "Preview", icon: PanelTopOpen },
  { value: "chunks", label: "Chunks", icon: Hash },
  { value: "raw", label: "Raw MD", icon: Code2 },
  { value: "source-file", label: "File", icon: FileText },
];

const SOURCE_FILE_TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "text/html",
  "text/xml",
  "text/css",
  "text/javascript",
  "text/yaml",
]);

function isTextSourceMimeType(mimeType: string | null | undefined) {
  if (!mimeType) {
    return false;
  }

  return (
    mimeType.startsWith("text/") || SOURCE_FILE_TEXT_MIME_TYPES.has(mimeType)
  );
}

function formatEnumLabel(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatBytes(sizeBytes: number | null | undefined) {
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes)) {
    return null;
  }

  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = sizeBytes;
  let unitIndex = -1;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const fractionDigits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(fractionDigits)} ${units[unitIndex]}`;
}

const sourceDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatTimestamp(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return sourceDateFormatter.format(parsed);
}

function SourceMetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border bg-muted/20 px-3.5 py-3">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 break-words text-sm font-medium leading-5 text-foreground">
        {value}
      </div>
    </div>
  );
}

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
  const [previewMode, setPreviewMode] = useState<PreviewMode>("preview");
  const [rawChunkIds, setRawChunkIds] = useState<Set<string>>(() => new Set());
  const scrollRootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      const isChunkCitation = Boolean(
        citation?.chunkId && !citation.externalUri,
      );
      setPreviewMode(isChunkCitation ? "chunks" : "preview");
      setRawChunkIds(new Set());
    }
  }, [citation?.chunkId, citation?.externalUri, open, source?.id]);

  useEffect(() => {
    if (
      !open ||
      citation?.externalUri ||
      !workspaceId ||
      (!citation && !source)
    ) {
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setDetail(null);
    setIsDeletedCitation(false);
    setIsHistoricalCitation(false);

    const request =
      citation && citation.sourceId && citation.documentId
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
    if (!open || !detail || !citation || previewMode !== "chunks") {
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
  }, [citation, detail, open, previewMode]);

  const citedChunk = detail?.chunks.find(
    (chunk) => chunk.id === citation?.chunkId,
  );
  const rawMarkdown =
    detail?.documents[0]?.contentText ?? detail?.source.contentText ?? "";
  const sourceMimeType = detail?.source.mimeType?.trim().toLowerCase() ?? null;
  const sourcePreviewUrl = detail?.source.previewUrl ?? null;
  const sourceDownloadUrl = detail?.source.downloadUrl ?? null;
  const sourceFileContent = detail?.source.contentText ?? "";
  const sourceSize = formatBytes(detail?.source.sizeBytes);
  const sourceUpdatedAt = formatTimestamp(detail?.source.updatedAt);
  const sourceTypeLabel =
    formatEnumLabel(detail?.source.sourceType ?? source?.sourceType) ??
    "Source";
  const title =
    detail?.source.title ?? citation?.sourceTitle ?? source?.title ?? "Source";
  const isExternalCitation = Boolean(citation?.externalUri);
  const toggleRawChunk = (chunkId: string) => {
    setRawChunkIds((current) => {
      const next = new Set(current);
      if (next.has(chunkId)) {
        next.delete(chunkId);
      } else {
        next.add(chunkId);
      }
      return next;
    });
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="flex h-[min(900px,calc(100vh-3rem))] w-[min(1120px,calc(100vw-2rem))] max-w-none flex-col overflow-hidden p-0"
        constrainWidth={false}
      >
        <DialogHeader className="relative overflow-hidden border-b bg-[radial-gradient(circle_at_top_left,hsl(var(--primary)/0.14),transparent_32%),linear-gradient(180deg,hsl(var(--background)),hsl(var(--muted)/0.34))] px-5 py-4">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />
          <div className="flex min-w-0 items-start justify-between gap-4 pr-9">
            <div className="min-w-0">
              <DialogTitle className="truncate text-lg font-semibold">
                {title}
              </DialogTitle>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge
                  className="h-6 gap-1.5 rounded-full border-border/70 bg-background/90 px-2.5 text-[11px] shadow-sm backdrop-blur"
                  variant="outline"
                >
                  <Hash className="size-3" />
                  {typeof citation?.chunkNo === "number"
                    ? `Chunk ${citation.chunkNo + 1}`
                    : citation
                      ? "Cited chunk"
                      : "Source preview"}
                </Badge>
                {detail?.chunks ? (
                  <Badge
                    className="h-6 rounded-full border-border/60 bg-background/70 px-2.5 text-[11px] text-muted-foreground"
                    variant="outline"
                  >
                    {detail.chunks.length} chunks
                  </Badge>
                ) : null}
                {detail?.source.mimeType ? (
                  <Badge
                    className="h-6 rounded-full border-border/60 bg-background/70 px-2.5 font-mono text-[11px] text-muted-foreground"
                    variant="outline"
                  >
                    {detail.source.mimeType}
                  </Badge>
                ) : null}
                {sourceSize ? (
                  <Badge
                    className="h-6 rounded-full border-border/60 bg-background/70 px-2.5 text-[11px] text-muted-foreground"
                    variant="outline"
                  >
                    {sourceSize}
                  </Badge>
                ) : null}
                {isHistoricalCitation ? (
                  <Badge className="h-6 rounded-full border-amber-300/70 bg-amber-100/80 px-2.5 text-[11px] font-medium text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-200">
                    Historical
                  </Badge>
                ) : null}
                {isDeletedCitation ? (
                  <Badge className="h-6 rounded-full border-slate-300/70 bg-slate-100/80 px-2.5 text-[11px] font-medium text-slate-700 dark:border-slate-500/30 dark:bg-slate-500/15 dark:text-slate-200">
                    Source deleted
                  </Badge>
                ) : null}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {detail ? (
                <Tabs
                  className="w-auto gap-0"
                  onValueChange={(value) =>
                    setPreviewMode(value as PreviewMode)
                  }
                  value={previewMode}
                >
                  <TabsList className="h-8 rounded-xl bg-muted/60 p-1">
                    {PREVIEW_MODE_OPTIONS.map((option) => (
                      <TabsTrigger
                        className="min-w-16 px-2.5 text-xs"
                        key={option.value}
                        value={option.value}
                      >
                        {option.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
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

        {isExternalCitation && citation ? (
          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto flex min-h-full max-w-4xl flex-col justify-center space-y-4 px-5 py-6 lg:px-8">
              <div className="rounded-2xl border border-dashed bg-muted/20 px-5 py-4 text-sm text-muted-foreground">
                <div className="mb-2 flex items-center gap-2 font-medium text-foreground">
                  <ExternalLink className="size-4" />
                  Web citation
                </div>
                This citation points to a public web page.
              </div>

              <article className="overflow-hidden rounded-2xl border bg-background shadow-xs">
                <div className="flex items-center justify-between gap-3 border-b bg-muted/25 px-4 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-foreground">
                      {citation.sourceTitle?.trim() || citation.externalUri}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {citation.externalUri}
                    </div>
                  </div>
                  <Button
                    className="shrink-0 gap-1.5"
                    onClick={() =>
                      window.open(
                        citation.externalUri,
                        "_blank",
                        "noopener,noreferrer",
                      )
                    }
                    size="xs"
                    type="button"
                    variant="outline"
                  >
                    <ExternalLink className="size-3.5" />
                    Open
                  </Button>
                </div>
                <div className="px-4 py-4 lg:px-5">
                  <MessageResponse className="text-sm leading-7 text-foreground">
                    {citation.content ||
                      citation.excerpt ||
                      "No citation content was saved."}
                  </MessageResponse>
                </div>
              </article>
            </div>
          </ScrollArea>
        ) : isLoading ? (
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
          previewMode === "source-file" ? (
            <ScrollArea className="min-h-0 flex-1">
              <div className="mx-auto flex min-h-full max-w-6xl flex-col px-5 py-6 lg:px-8">
                <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
                  <section className="overflow-hidden rounded-[28px] border border-border/70 bg-[linear-gradient(160deg,hsl(var(--background)),hsl(var(--muted)/0.18))] shadow-[0_20px_60px_-32px_hsl(var(--foreground)/0.35)]">
                    {sourceDownloadUrl ? (
                      <div className="flex justify-end border-b border-border/70 bg-background/80 px-5 py-3 backdrop-blur">
                        <Button
                          asChild
                          className="gap-1.5 rounded-xl"
                          size="sm"
                          variant="outline"
                        >
                          <a
                            href={sourceDownloadUrl}
                            rel="noreferrer"
                            target="_blank"
                          >
                            <Download className="size-3.5" />
                            Download
                          </a>
                        </Button>
                      </div>
                    ) : null}

                    <div className="relative">
                      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,hsl(var(--primary)/0.10),transparent_42%)]" />
                      {sourceMimeType?.startsWith("image/") &&
                      sourcePreviewUrl ? (
                        <div className="relative flex min-h-[520px] items-center justify-center overflow-hidden bg-[linear-gradient(180deg,hsl(var(--muted)/0.10),transparent_18%),radial-gradient(circle_at_center,hsl(var(--background)),hsl(var(--muted)/0.32))] p-5 sm:p-8">
                          <div className="absolute inset-0 bg-[linear-gradient(45deg,hsl(var(--border)/0.28)_25%,transparent_25%,transparent_75%,hsl(var(--border)/0.28)_75%,hsl(var(--border)/0.28)),linear-gradient(45deg,hsl(var(--border)/0.28)_25%,transparent_25%,transparent_75%,hsl(var(--border)/0.28)_75%,hsl(var(--border)/0.28))] bg-[position:0_0,14px_14px] bg-[size:28px_28px] opacity-[0.18]" />
                          <div className="relative max-h-[72vh] w-full overflow-hidden rounded-[24px] border border-white/60 bg-white/88 p-4 shadow-[0_24px_80px_-32px_rgba(0,0,0,0.45)] backdrop-blur dark:border-white/10 dark:bg-black/20">
                            <div className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent" />
                            <RawImage
                              alt={title}
                              className="max-h-[calc(72vh-2rem)] w-full rounded-[18px] object-contain"
                              src={sourcePreviewUrl}
                            />
                          </div>
                        </div>
                      ) : sourceMimeType === "application/pdf" &&
                        sourcePreviewUrl ? (
                        <div className="bg-muted/8 p-4 sm:p-5">
                          <div className="overflow-hidden rounded-[22px] border border-border/70 bg-background shadow-[0_20px_60px_-36px_hsl(var(--foreground)/0.4)]">
                            <iframe
                              className="h-[72vh] w-full"
                              src={sourcePreviewUrl}
                              title={`${title} source file`}
                            />
                          </div>
                        </div>
                      ) : isTextSourceMimeType(sourceMimeType) &&
                        sourceFileContent ? (
                        <div className="bg-muted/8 p-4 sm:p-5">
                          <div className="overflow-hidden rounded-[22px] border border-border/70 bg-background shadow-[0_20px_60px_-36px_hsl(var(--foreground)/0.35)]">
                            <pre className="max-h-[72vh] overflow-auto whitespace-pre-wrap break-words px-5 py-4 font-mono text-xs leading-6 text-foreground">
                              {sourceFileContent}
                            </pre>
                          </div>
                        </div>
                      ) : (
                        <div className="flex min-h-[520px] flex-1 flex-col items-center justify-center px-6 py-12 text-center">
                          <div className="inline-flex size-14 items-center justify-center rounded-[20px] border border-dashed border-border bg-background/75 text-muted-foreground shadow-sm">
                            <PanelTopOpen className="size-6" />
                          </div>
                          <p className="mt-4 text-sm font-semibold text-foreground">
                            暂不支持预览
                          </p>
                          <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                            该文件格式暂不支持在线预览，可下载源文件查看。
                          </p>
                          {sourceDownloadUrl ? (
                            <Button
                              asChild
                              className="mt-5 gap-1.5 rounded-xl"
                              size="sm"
                              variant="outline"
                            >
                              <a
                                href={sourceDownloadUrl}
                                rel="noreferrer"
                                target="_blank"
                              >
                                <Download className="size-3.5" />
                                Download source file
                              </a>
                            </Button>
                          ) : null}
                        </div>
                      )}
                    </div>
                  </section>

                  <aside className="space-y-4">
                    <div className="overflow-hidden rounded-[24px] border border-border/70 bg-background/92 shadow-[0_18px_60px_-40px_hsl(var(--foreground)/0.45)] backdrop-blur">
                      <div className="border-b border-border/70 px-4 py-3">
                        <div className="text-sm font-semibold text-foreground">
                          File details
                        </div>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          Quick metadata for the original source asset.
                        </p>
                      </div>
                      <div className="space-y-3 px-4 py-4">
                        <SourceMetaRow label="Name" value={title} />
                        <SourceMetaRow label="Type" value={sourceTypeLabel} />
                        <SourceMetaRow
                          label="Format"
                          value={sourceMimeType ?? "Unknown"}
                        />
                        {sourceSize ? (
                          <SourceMetaRow label="Size" value={sourceSize} />
                        ) : null}
                        {sourceUpdatedAt ? (
                          <SourceMetaRow
                            label="Updated"
                            value={sourceUpdatedAt}
                          />
                        ) : null}
                        <SourceMetaRow
                          label="Indexed chunks"
                          value={String(detail.chunks.length)}
                        />
                      </div>
                    </div>
                  </aside>
                </div>
              </div>
            </ScrollArea>
          ) : previewMode === "raw" ? (
            <ScrollArea className="min-h-0 flex-1">
              <pre className="mx-auto min-h-full max-w-5xl whitespace-pre-wrap break-words px-5 py-6 font-mono text-xs leading-6 text-foreground lg:px-8">
                {rawMarkdown || "No markdown content available."}
              </pre>
            </ScrollArea>
          ) : previewMode === "preview" ? (
            <ScrollArea className="min-h-0 flex-1">
              <article className="mx-auto min-h-full max-w-4xl px-5 py-6 lg:px-8">
                <MessageResponse className="text-sm leading-7 text-foreground [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:px-3 [&_td]:py-2 [&_th]:border [&_th]:bg-muted/40 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left">
                  {rawMarkdown || "No markdown content available."}
                </MessageResponse>
              </article>
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
                    const isRawOpen = rawChunkIds.has(chunk.id);
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
                        <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/25 px-4 py-3">
                          <div className="flex min-w-0 items-center gap-2.5">
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
                          <div className="flex shrink-0 items-center gap-2">
                            {isCited ? (
                              <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
                                <Sparkles className="size-3.5" />
                                Cited source
                              </span>
                            ) : null}
                            <Button
                              aria-expanded={isRawOpen}
                              className="h-7 gap-1.5 px-2 text-xs"
                              onClick={() => toggleRawChunk(chunk.id)}
                              size="xs"
                              type="button"
                              variant={isRawOpen ? "secondary" : "ghost"}
                            >
                              <Code2 className="size-3.5" />
                              Raw
                            </Button>
                          </div>
                        </div>
                        <div className="px-4 py-4 lg:px-5">
                          {isRawOpen ? (
                            <pre className="max-h-96 overflow-auto font-mono text-xs leading-5 whitespace-pre-wrap break-words text-muted-foreground">
                              {chunk.content || "No raw chunk content."}
                            </pre>
                          ) : (
                            <MessageResponse className="text-sm leading-7 text-foreground [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:px-3 [&_td]:py-2 [&_th]:border [&_th]:bg-muted/40 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left">
                              {chunk.content}
                            </MessageResponse>
                          )}
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
