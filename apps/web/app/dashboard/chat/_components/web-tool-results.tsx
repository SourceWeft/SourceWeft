"use client";

import { useState } from "react";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { ChevronDown, ChevronUp, Files, FileText, Globe } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { isAgentToolDomain } from "@sourceweft/agent-tool-registry";
import { RawImage } from "../../../_components/raw-image";
import {
  ASSISTANT_ACTIVITY_DETAIL_CLASS,
  ASSISTANT_ACTIVITY_ICON_CLASS,
  ASSISTANT_ACTIVITY_LABEL_CLASS,
  ASSISTANT_ACTIVITY_ROW_CLASS,
} from "./chat-canvas/assistant-activity-layout";
import type { CitationRecord, ToolCallRecord } from "./chat-canvas";
import {
  getWebPageToolResults,
  type WebPageToolResult,
} from "./web-tool-results-state";

export {
  getWebPageToolCallIds,
  hasWebPageToolResults,
  shouldRenderWebToolResultsFallback,
} from "./web-tool-results-state";

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
  className,
  onCitationClick,
  toolCall,
  toolCalls,
  variant = "pill",
}: {
  availableCitations?: CitationRecord[];
  className?: string;
  onCitationClick?: (citation: CitationRecord) => void;
  toolCall?: ToolCallRecord;
  toolCalls?: ToolCallRecord[] | undefined;
  variant?: "activity-row" | "pill";
}) {
  const resolvedToolCalls = toolCall ? [toolCall] : (toolCalls ?? []);
  const webToolCalls = resolvedToolCalls.filter((toolCall) =>
    isAgentToolDomain(toolCall.tool, "web")
  );
  const pages = webToolCalls.flatMap((toolCall) => getWebPageToolResults(toolCall));
  const [isOpen, setIsOpen] = useState(false);

  if (pages.length === 0) {
    return null;
  }

  if (variant === "activity-row") {
    return (
      <div className={cn("text-muted-foreground", className)}>
        <button
          aria-expanded={isOpen}
          aria-label={
            isOpen
              ? "Collapse referenced web pages"
              : "Expand referenced web pages"
          }
          className={ASSISTANT_ACTIVITY_ROW_CLASS}
          onClick={() => setIsOpen((value) => !value)}
          type="button"
        >
          <span className={ASSISTANT_ACTIVITY_ICON_CLASS}>
            <Files className="size-3.5 text-muted-foreground/75" />
          </span>
          <span className={ASSISTANT_ACTIVITY_LABEL_CLASS}>
            <span className="truncate text-[13px] text-foreground/80">
              Referenced web pages
            </span>
            <span className="shrink-0 text-muted-foreground/60 text-xs">
              {pages.length}
            </span>
          </span>
          <span className="grid size-4 shrink-0 place-items-center">
            {isOpen ? (
              <ChevronUp className="size-3 text-muted-foreground/50" />
            ) : (
              <ChevronDown className="size-3 text-muted-foreground/50" />
            )}
          </span>
        </button>

        {isOpen ? (
          <WebPageList
            availableCitations={availableCitations}
            onCitationClick={onCitationClick}
            pages={pages}
            variant="activity-row"
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className={cn("mt-2 w-full max-w-xl text-foreground", className)}>
      <button
        aria-label={
          isOpen
            ? "Collapse referenced web pages"
            : "Expand referenced web pages"
        }
        className="inline-flex h-7 items-center gap-2 rounded-full border border-border/60 bg-card px-2.5 text-xs font-normal text-foreground shadow-xs transition-colors hover:bg-muted/50"
        onClick={() => setIsOpen((value) => !value)}
        type="button"
      >
        <Files className="size-4" />
        <span>Referenced web pages</span>
        <span className="text-muted-foreground">{pages.length}</span>
        {isOpen ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
      </button>

      {isOpen ? (
        <WebPageList
          availableCitations={availableCitations}
          onCitationClick={onCitationClick}
          pages={pages}
          variant="pill"
        />
      ) : null}
    </div>
  );
}

function WebPageList({
  availableCitations,
  onCitationClick,
  pages,
  variant,
}: {
  availableCitations?: CitationRecord[];
  onCitationClick?: (citation: CitationRecord) => void;
  pages: WebPageToolResult[];
  variant: "activity-row" | "pill";
}) {
  return (
    <div
      className={cn(
        variant === "activity-row"
          ? cn(ASSISTANT_ACTIVITY_DETAIL_CLASS, "space-y-1.5 p-1.5")
          : "mt-1.5 space-y-1 rounded-xl border border-border/60 bg-card p-1.5 shadow-xs",
      )}
    >
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
                  <RawImage
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
  );
}
