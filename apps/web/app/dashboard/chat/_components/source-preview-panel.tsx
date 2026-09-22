"use client";
import { formatDisplayDate } from "@/lib/i18n/format";

import { useLocale as useDisplayLocale } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { FileCitationPreview } from "./file-citation-preview";
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
import { useTranslations } from "next-intl";
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
import { Preview } from "@sourceweft/preview/react";
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

function formatTimestamp(
  value: string | null | undefined,
  displayLocale: string,
) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return formatDisplayDate(parsed, displayLocale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
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
  const displayLocale = useDisplayLocale();
  const t = useTranslations("dashboardSourcesHub");
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
        citation?.chunkId && !citation.externalUri && !citation.fileReference,
      );
      setPreviewMode(isChunkCitation ? "chunks" : "preview");
      setRawChunkIds(new Set());
    }
  }, [
    citation?.chunkId,
    citation?.externalUri,
    citation?.fileReference,
    open,
    source?.id,
  ]);

  useEffect(() => {
    if (
      !open ||
      citation?.externalUri ||
      citation?.fileReference ||
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
              : t("sourcePreview.loadFailed"),
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
  }, [citation, open, source, workspaceId, t]);

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
  const sourceUpdatedAt = formatTimestamp(
    detail?.source.updatedAt,
    displayLocale,
  );
  const sourceTypeLabel =
    formatEnumLabel(detail?.source.sourceType ?? source?.sourceType) ??
    t("sourcePreview.sourceFallback");
  const title =
    detail?.source.title ??
    citation?.sourceTitle ??
    source?.title ??
    t("sourcePreview.sourceFallback");
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

  if (citation?.fileReference)
    return (
      <FileCitationPreview
        reference={citation.fileReference}
        excerpt={citation.content ?? citation.excerpt}
        open={open}
        onOpenChange={onOpenChange}
      />
    );
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
                    ? t("sourcePreview.chunkLabel", {
                        number: citation.chunkNo + 1,
                      })
                    : citation
                      ? t("sourcePreview.citedChunk")
                      : t("sourcePreview.sourcePreview")}
                </Badge>
                {detail?.chunks ? (
                  <Badge
                    className="h-6 rounded-full border-border/60 bg-background/70 px-2.5 text-[11px] text-muted-foreground"
                    variant="outline"
                  >
                    {t("sourcePreview.chunksCount", {
                      count: detail.chunks.length,
                    })}
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
                    {t("sourcePreview.historical")}
                  </Badge>
                ) : null}
                {isDeletedCitation ? (
                  <Badge className="h-6 rounded-full border-slate-300/70 bg-slate-100/80 px-2.5 text-[11px] font-medium text-slate-700 dark:border-slate-500/30 dark:bg-slate-500/15 dark:text-slate-200">
                    {t("sourcePreview.sourceDeleted")}
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
                        {t(
                          `sourcePreview.mode.${
                            option.value === "source-file"
                              ? "sourceFile"
                              : option.value
                          }`,
                        )}
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
                  {t("sourcePreview.jumpToCited")}
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
                  {t("sourcePreview.webCitation")}
                </div>
                {t("sourcePreview.webCitationNote")}
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
                    {t("sourcePreview.open")}
                  </Button>
                </div>
                <div className="px-4 py-4 lg:px-5">
                  <MessageResponse className="text-sm leading-7 text-foreground">
                    {citation.content ||
                      citation.excerpt ||
                      t("sourcePreview.noContentSaved")}
                  </MessageResponse>
                </div>
              </article>
            </div>
          </ScrollArea>
        ) : isLoading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            {t("sourcePreview.loading")}
          </div>
        ) : isDeletedCitation && citation ? (
          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto flex min-h-full max-w-4xl flex-col justify-center space-y-4 px-5 py-6 lg:px-8">
              <div className="rounded-2xl border border-dashed bg-muted/20 px-5 py-4 text-sm text-muted-foreground">
                <div className="mb-2 flex items-center gap-2 font-medium text-foreground">
                  <FileText className="size-4" />
                  {t("sourcePreview.sourceUnavailable")}
                </div>
                {t("sourcePreview.sourceUnavailableNote")}
              </div>

              <article className="overflow-hidden rounded-2xl border bg-background shadow-xs">
                <div className="flex items-center justify-between border-b bg-muted/25 px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                      <Hash className="size-3.5" />
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">
                        {citation.sourceTitle?.trim() ||
                          t("sourcePreview.deletedSourceFallback")}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {typeof citation.chunkNo === "number"
                          ? t("sourcePreview.chunkLabel", {
                              number: citation.chunkNo + 1,
                            })
                          : t("sourcePreview.citedChunk")}
                      </div>
                    </div>
                  </div>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
                    <Sparkles className="size-3.5" />
                    {t("sourcePreview.preservedCitation")}
                  </span>
                </div>
                <div className="px-4 py-4 lg:px-5">
                  <MessageResponse className="text-sm leading-7 text-foreground [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:px-3 [&_td]:py-2 [&_th]:border [&_th]:bg-muted/40 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left">
                    {citation.excerpt || t("sourcePreview.noExcerptSaved")}
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
                            {t("sourcePreview.download")}
                          </a>
                        </Button>
                      </div>
                    ) : null}

                    <div className="relative">
                      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,hsl(var(--primary)/0.10),transparent_42%)]" />
                      {sourcePreviewUrl || sourceDownloadUrl ? (
                        <div className="h-[72vh]">
                          <Preview
                            source={{
                              name: title,
                              mimeType: sourceMimeType,
                              url: (sourcePreviewUrl || sourceDownloadUrl)!,
                            }}
                          />
                        </div>
                      ) : isTextSourceMimeType(sourceMimeType) ? (
                        <div className="h-[72vh]">
                          <Preview
                            source={{
                              name: title,
                              mimeType: sourceMimeType,
                              text: sourceFileContent,
                            }}
                          />
                        </div>
                      ) : (
                        <p className="p-6">{t("sourcePreview.noSourceFile")}</p>
                      )}
                    </div>
                  </section>

                  <aside className="space-y-4">
                    <div className="overflow-hidden rounded-[24px] border border-border/70 bg-background/92 shadow-[0_18px_60px_-40px_hsl(var(--foreground)/0.45)] backdrop-blur">
                      <div className="border-b border-border/70 px-4 py-3">
                        <div className="text-sm font-semibold text-foreground">
                          {t("sourcePreview.fileDetails")}
                        </div>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          {t("sourcePreview.fileDetailsNote")}
                        </p>
                      </div>
                      <div className="space-y-3 px-4 py-4">
                        <SourceMetaRow
                          label={t("sourcePreview.metaName")}
                          value={title}
                        />
                        <SourceMetaRow
                          label={t("sourcePreview.metaType")}
                          value={sourceTypeLabel}
                        />
                        <SourceMetaRow
                          label={t("sourcePreview.metaFormat")}
                          value={sourceMimeType ?? t("sourcePreview.unknown")}
                        />
                        {sourceSize ? (
                          <SourceMetaRow
                            label={t("sourcePreview.metaSize")}
                            value={sourceSize}
                          />
                        ) : null}
                        {sourceUpdatedAt ? (
                          <SourceMetaRow
                            label={t("sourcePreview.metaUpdated")}
                            value={sourceUpdatedAt}
                          />
                        ) : null}
                        <SourceMetaRow
                          label={t("sourcePreview.metaIndexedChunks")}
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
                {rawMarkdown || t("sourcePreview.noMarkdown")}
              </pre>
            </ScrollArea>
          ) : previewMode === "preview" ? (
            <ScrollArea className="min-h-0 flex-1">
              <article className="mx-auto min-h-full max-w-4xl px-5 py-6 lg:px-8">
                <MessageResponse className="text-sm leading-7 text-foreground [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:px-3 [&_td]:py-2 [&_th]:border [&_th]:bg-muted/40 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left">
                  {rawMarkdown || t("sourcePreview.noMarkdown")}
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
                            title={t("sourcePreview.chunkLabel", {
                              number: index + 1,
                            })}
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
                              {t("sourcePreview.chunkLabel", {
                                number: index + 1,
                              })}
                            </span>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {isCited ? (
                              <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
                                <Sparkles className="size-3.5" />
                                {t("sourcePreview.citedSource")}
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
                              {t("sourcePreview.raw")}
                            </Button>
                          </div>
                        </div>
                        <div className="px-4 py-4 lg:px-5">
                          {isRawOpen ? (
                            <pre className="max-h-96 overflow-auto font-mono text-xs leading-5 whitespace-pre-wrap break-words text-muted-foreground">
                              {chunk.content || t("sourcePreview.noRawChunk")}
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
                      {t("sourcePreview.noChunks")}
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
