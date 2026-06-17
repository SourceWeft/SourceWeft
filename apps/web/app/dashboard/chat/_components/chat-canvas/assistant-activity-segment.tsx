import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  CheckCircle2,
  ChevronRight,
  Circle,
  Lightbulb,
  Loader2,
} from "lucide-react";
import { cn } from "@sourceweft/ui-web/lib/utils";
import {
  ASSISTANT_ACTIVITY_DETAIL_CLASS,
  ASSISTANT_ACTIVITY_DETAIL_TEXT_CLASS,
  ASSISTANT_ACTIVITY_ICON_CLASS,
  ASSISTANT_ACTIVITY_LABEL_CLASS,
  ASSISTANT_ACTIVITY_ROW_CLASS,
} from "./assistant-activity-layout";
import type { AssistantActivityItem } from "./assistant-activity-items";
import { AssistantToolCard } from "./assistant-tool-card";
import { WebToolResults } from "../web-tool-results";
import type {
  CitationRecord,
  ToolConfirmationResolution,
} from "./types";
import { formatThoughtDuration } from "./duration-format";

function ActivityStatusCell({ children }: { children: ReactNode }) {
  return (
    <span className={ASSISTANT_ACTIVITY_ICON_CLASS}>
      {children}
    </span>
  );
}

function ActivityDisclosureIcon({ isOpen }: { isOpen: boolean }) {
  return (
    <ChevronRight
      className={cn(
        "size-3 shrink-0 text-muted-foreground/50 transition-transform",
        isOpen && "rotate-90",
      )}
    />
  );
}

function StepStatusIcon({ status }: { status: "pending" | "in_progress" | "completed" }) {
  if (status === "in_progress") {
    return (
      <Loader2 className="size-3.5 animate-spin text-primary motion-reduce:animate-none" />
    );
  }
  if (status === "completed") {
    return <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />;
  }
  return <Circle className="size-3.5 text-muted-foreground/70" />;
}

function AssistantStepRow({ item }: { item: Extract<AssistantActivityItem, { type: "step" }> }) {
  const [isOpen, setIsOpen] = useState(false);
  const metadataKeys: Array<readonly [string, string]> = [
    ["sourceCount", "sources"],
    ["resultCount", "results"],
    ["hitCount", "hits"],
    ["latencyMs", "ms"],
  ];
  const metadataLabels = metadataKeys
    .map(([key, label]) => {
      const value = item.metadata?.[key];
      return typeof value === "number" && Number.isFinite(value)
        ? `${value} ${label}`
        : null;
    })
      .filter((value): value is string => value !== null);
  const hasDetails = item.items.length > 0 || metadataLabels.length > 0;

  return (
    <div className="group text-muted-foreground transition-colors hover:text-foreground">
      <button
        aria-expanded={hasDetails ? isOpen : undefined}
        className={ASSISTANT_ACTIVITY_ROW_CLASS}
        disabled={!hasDetails}
        onClick={() => setIsOpen((value) => !value)}
        type="button"
      >
        <ActivityStatusCell>
          <StepStatusIcon status={item.status} />
        </ActivityStatusCell>
        <span className={ASSISTANT_ACTIVITY_LABEL_CLASS}>
          <span className="truncate text-[13px] text-foreground/80">
            {item.title}
          </span>
          {item.status === "in_progress" ? (
            <span className="shrink-0 text-primary/75 text-xs">Running</span>
          ) : null}
        </span>
        {hasDetails ? <ActivityDisclosureIcon isOpen={isOpen} /> : null}
      </button>
      {isOpen && hasDetails ? (
        <div className={ASSISTANT_ACTIVITY_DETAIL_CLASS}>
          {metadataLabels.length > 0 ? (
            <p className="break-words">{metadataLabels.join(" · ")}</p>
          ) : null}
          {item.items.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {item.items.slice(0, 8).map((label) => (
                <span
                  className="max-w-[220px] truncate rounded-md bg-muted/45 px-1.5 py-0.5 text-muted-foreground"
                  key={label}
                  title={label}
                >
                  {label}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AssistantReasoningRow({
  isStreaming = false,
  item,
}: {
  isStreaming?: boolean;
  item: Extract<AssistantActivityItem, { type: "reasoning" }>;
}) {
  const title = isStreaming
    ? "Thinking..."
    : formatThoughtDuration(item.durationMs);
  const [isOpen, setIsOpen] = useState(isStreaming);

  useEffect(() => {
    setIsOpen(isStreaming);
  }, [isStreaming]);

  return (
    <div className="group text-muted-foreground transition-colors hover:text-foreground">
      <button
        aria-expanded={isOpen}
        className={ASSISTANT_ACTIVITY_ROW_CLASS}
        onClick={() => setIsOpen((value) => !value)}
        type="button"
      >
        <ActivityStatusCell>
          {isStreaming ? (
            <Loader2 className="size-3.5 animate-spin text-primary motion-reduce:animate-none" />
          ) : (
            <Lightbulb className="size-3.5 text-muted-foreground/70" />
          )}
        </ActivityStatusCell>
        <span className={ASSISTANT_ACTIVITY_LABEL_CLASS}>
          <span className="truncate text-[13px] text-foreground/80">
            {title}
          </span>
        </span>
        <ActivityDisclosureIcon isOpen={isOpen} />
      </button>
      {isOpen ? (
        <div className={ASSISTANT_ACTIVITY_DETAIL_TEXT_CLASS}>
          {item.text}
        </div>
      ) : null}
    </div>
  );
}

export function AssistantActivitySegment({
  availableCitations,
  isStreaming = false,
  item,
  onCitationClick,
  onWorkfileClick,
  resolvedConfirmations,
}: {
  availableCitations?: CitationRecord[];
  isStreaming?: boolean;
  item: AssistantActivityItem;
  onCitationClick?: (citation: CitationRecord) => void;
  onWorkfileClick?: (path: string) => void;
  resolvedConfirmations?: ToolConfirmationResolution[];
}) {
  if (item.type === "reasoning") {
    return <AssistantReasoningRow isStreaming={isStreaming} item={item} />;
  }

  if (item.type === "step") {
    return <AssistantStepRow item={item} />;
  }

  return (
    <>
      <AssistantToolCard
        onWorkfileClick={onWorkfileClick}
        resolvedConfirmations={resolvedConfirmations}
        toolCall={item.toolCall}
        toolStep={item.toolStep}
      />
      <WebToolResults
        availableCitations={availableCitations}
        onCitationClick={onCitationClick}
        toolCall={item.toolCall}
        variant="activity-row"
      />
    </>
  );
}
