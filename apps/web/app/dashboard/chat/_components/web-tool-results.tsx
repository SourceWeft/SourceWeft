"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, FileText, Globe } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import type { CitationRecord, ToolCallRecord } from "./chat-canvas";

type WebPageToolResult = {
  url: string;
  title?: string;
  rank?: number;
  citation?: string;
  wordCount?: number;
  error?: string;
  truncated?: boolean;
  hasContent?: boolean;
};

function toObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getFetchInputUrls(toolCall: ToolCallRecord) {
  const items = toolCall.input.items;
  if (!Array.isArray(items)) {
    return [] as string[];
  }

  return items
    .map((item) => {
      const record = toObjectRecord(item);
      const url = typeof record?.url === "string" ? record.url.trim() : "";
      return url || null;
    })
    .filter((url): url is string => url !== null);
}

export function getWebPageToolResults(toolCall: ToolCallRecord): WebPageToolResult[] {
  const outputRecord = toObjectRecord(toolCall.output);
  const pages = outputRecord?.pages;
  if (Array.isArray(pages)) {
    return pages
      .map((item): WebPageToolResult | null => {
        const record = toObjectRecord(item);
        const url = typeof record?.url === "string" ? record.url.trim() : "";
        if (!url) {
          return null;
        }
        const title = typeof record?.title === "string" && record.title.trim()
          ? record.title.trim()
          : undefined;
        const rank = typeof record?.rank === "number" && Number.isFinite(record.rank)
          ? record.rank
          : undefined;
        const citation = typeof record?.citation === "string" && record.citation.trim()
          ? record.citation.trim()
          : undefined;
        const wordCount = typeof record?.wordCount === "number" && Number.isFinite(record.wordCount)
          ? record.wordCount
          : undefined;
        const error = typeof record?.error === "string" && record.error.trim()
          ? record.error.trim()
          : undefined;
        return {
          url,
          ...(title ? { title } : {}),
          ...(rank !== undefined ? { rank } : {}),
          ...(citation ? { citation } : {}),
          ...(wordCount !== undefined ? { wordCount } : {}),
          ...(error ? { error } : {}),
          ...(record?.truncated === true ? { truncated: true } : {}),
          ...(record?.hasContent === true ? { hasContent: true } : {}),
        };
      })
      .filter((item): item is WebPageToolResult => item !== null);
  }

  return getFetchInputUrls(toolCall).map((url, index) => ({
    url,
    rank: index + 1,
  }));
}

function getHostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function getFaviconUrl(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return "";
  }
}

export function hasWebPageToolResults(toolCalls: ToolCallRecord[] | undefined) {
  return (toolCalls ?? []).some((toolCall) =>
    (toolCall.tool === "web_search" || toolCall.tool === "web_fetch") &&
    getWebPageToolResults(toolCall).length > 0
  );
}

function resolveCitationForPage(
  page: WebPageToolResult,
  citations: CitationRecord[] | undefined,
) {
  return (citations ?? []).find((citation) =>
    (page.citation && citation.citation === page.citation) ||
    citation.externalUri === page.url ||
    citation.chunkId === `external:${page.url}`
  ) ?? null;
}

export function WebToolResults({
  availableCitations,
  onCitationClick,
  toolCalls,
}: {
  availableCitations?: CitationRecord[];
  onCitationClick?: (citation: CitationRecord) => void;
  toolCalls: ToolCallRecord[] | undefined;
}) {
  const webToolCalls = (toolCalls ?? []).filter((toolCall) =>
    toolCall.tool === "web_search" || toolCall.tool === "web_fetch"
  );
  const pages = webToolCalls.flatMap((toolCall) => getWebPageToolResults(toolCall));
  const [isOpen, setIsOpen] = useState(true);

  useEffect(() => {
    if (webToolCalls.some((toolCall) => toolCall.status === "running")) {
      setIsOpen(true);
    }
  }, [webToolCalls]);

  if (pages.length === 0) {
    return null;
  }

  return (
    <div className="mt-2 w-full max-w-xl text-foreground">
      <button
        aria-label={isOpen ? "Collapse webpages" : "Expand webpages"}
        className="inline-flex h-7 items-center gap-2 rounded-full border border-border/60 bg-card px-2.5 text-xs font-normal text-foreground shadow-xs transition-colors hover:bg-muted/50"
        onClick={() => setIsOpen((value) => !value)}
        type="button"
      >
        <Globe className="size-4" />
        <span>Webpages</span>
        <span className="text-muted-foreground">{pages.length}</span>
        {isOpen ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
      </button>

      {isOpen ? (
        <div className="mt-1.5 space-y-1 rounded-xl border border-border/60 bg-card p-1.5 shadow-xs">
          {pages.map((page, index) => {
            const host = getHostname(page.url);
            const title = page.title || host || page.url;
            const faviconUrl = getFaviconUrl(page.url);
            const citation = resolveCitationForPage(page, availableCitations);
            return (
              <div
                className="group relative rounded-lg px-2 py-[7px] transition-colors hover:bg-muted/50"
                key={`${page.url}:${page.rank ?? index}`}
              >
                <button
                  className="grid w-full min-w-0 grid-cols-[16px_minmax(0,1fr)_14px] items-center gap-2 rounded-lg text-left text-xs text-foreground no-underline"
                  onClick={() => {
                    if (citation) {
                      onCitationClick?.(citation);
                      return;
                    }
                    toast.info("No citation content is available for this page yet.");
                  }}
                  title={`${title}\n${page.url}`}
                  type="button"
                >
                  <span className="flex size-4 items-center justify-center overflow-hidden rounded-sm bg-muted">
                    {faviconUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        alt=""
                        className="size-4"
                        onError={(event) => {
                          event.currentTarget.style.display = "none";
                        }}
                        src={faviconUrl}
                      />
                    ) : (
                      <Globe className="size-3" />
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">
                      {title}
                    </span>
                    <span className="block truncate text-[11px] leading-4 text-muted-foreground">
                      {page.url}
                    </span>
                  </span>
                  <FileText className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
                {page.error ? (
                  <div className="mt-1 truncate pl-6 text-[11px] text-destructive">
                    {page.error}
                  </div>
                ) : null}
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center rounded-lg bg-linear-to-l from-card via-card/95 to-transparent pl-8 pr-2 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                  <Button
                    className="h-6 rounded-full px-2.5 text-xs"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      toast.info("Save to sources is not wired yet.");
                    }}
                    size="xs"
                    type="button"
                  >
                    Save
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
