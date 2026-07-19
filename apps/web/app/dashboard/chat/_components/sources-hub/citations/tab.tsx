import { FileText } from "lucide-react";

import { Button } from "@sourceweft/ui-web/components/ui/button";
import { cn } from "@sourceweft/ui-web/lib/utils";
import type { CitationRecord } from "../../chat-canvas";
import type {
  CitationOpenContext,
  CitationScope,
  DisplayCitationItem,
} from "./use-citations";

export function CitationsTab({
  activeCitationChunkId,
  activeCitationIndex,
  activeCitationItems,
  citationScope,
  currentCitationItems,
  currentCitationMessageId,
  filteredCitationItems,
  mode,
  onCitationLocate,
  onCitationOpen,
  onScopeChange,
  searchQuery,
  threadCitationItems,
}: {
  activeCitationChunkId: string | null;
  activeCitationIndex: number | null;
  activeCitationItems: DisplayCitationItem[];
  citationScope: CitationScope;
  currentCitationItems: DisplayCitationItem[];
  currentCitationMessageId: string | null;
  filteredCitationItems: DisplayCitationItem[];
  mode: "thread" | "new";
  onCitationLocate?: (messageId: string) => void;
  onCitationOpen?: (
    citation: CitationRecord,
    context?: CitationOpenContext,
  ) => void;
  onScopeChange: (scope: CitationScope) => void;
  searchQuery: string;
  threadCitationItems: DisplayCitationItem[];
}) {
  return (
    <section className="space-y-1">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-medium text-foreground">Citations</h3>
          <span className="text-[10px] text-muted-foreground">
            {citationScope === "thread"
              ? `${threadCitationItems.length} in thread`
              : `${currentCitationItems.length} current`}
          </span>
          {searchQuery ? (
            <span className="text-[10px] text-primary">
              {filteredCitationItems.length} found
            </span>
          ) : null}
        </div>
      </div>

      {mode === "thread" ? (
        <div className="mb-2 grid grid-cols-2 rounded-lg border bg-muted/30 p-1">
          {(
            [
              ["current", `Current (${currentCitationItems.length})`],
              ["thread", `Thread (${threadCitationItems.length})`],
            ] as const
          ).map(([scope, label]) => (
            <button
              className={cn(
                "rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                citationScope === scope
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
              key={scope}
              onClick={() => onScopeChange(scope)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      {filteredCitationItems.length === 0 ? (
        <div className="px-2 py-6 text-center text-xs text-muted-foreground">
          {searchQuery
            ? `No citations match "${searchQuery}".`
            : citationScope === "thread"
              ? "No citations found in this thread."
              : "No citations used in the selected answer."}
        </div>
      ) : (
        <div className="space-y-1.5">
          {filteredCitationItems.map((citation) => {
            const citationRecord = citation.citationRecord;
            const displayIndex =
              activeCitationItems.findIndex((item) => item.id === citation.id) +
              1;
            const isActive =
              citationScope === "current"
                ? activeCitationIndex === displayIndex
                : activeCitationChunkId === citationRecord.chunkId;
            const locateMessageId =
              citation.messageId ??
              (citationScope === "current" ? currentCitationMessageId : null);
            const canLocate = Boolean(locateMessageId);

            return (
              <article
                className={cn(
                  "rounded-xl border bg-background p-3 shadow-xs transition-colors",
                  isActive && "border-primary/45 bg-primary/5 shadow-sm",
                  canLocate &&
                    "cursor-pointer hover:border-primary/30 hover:bg-primary/5",
                )}
                key={citation.id}
                onClick={() => {
                  if (locateMessageId) {
                    onCitationLocate?.(locateMessageId);
                  }
                }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <span className="mt-0.5 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 px-1.5 text-[10px] font-semibold text-primary">
                      {displayIndex}
                    </span>
                    <div className="min-w-0">
                      <h4 className="truncate text-sm font-medium text-foreground">
                        {citation.sourceTitle}
                      </h4>
                      <div className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                        {citation.messageLabel}
                      </div>
                    </div>
                  </div>
                  <Button
                    onClick={(event) => {
                      event.stopPropagation();
                      onCitationOpen?.(citationRecord, {
                        messageId: locateMessageId ?? undefined,
                      });
                    }}
                    size="xs"
                    type="button"
                    variant="outline"
                  >
                    <FileText className="size-3.5" />
                    Open
                  </Button>
                </div>
                <div className="mt-2 line-clamp-4 rounded-lg border border-input bg-muted/20 px-2.5 py-2 text-sm leading-6 text-foreground/90">
                  {citation.excerpt}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
