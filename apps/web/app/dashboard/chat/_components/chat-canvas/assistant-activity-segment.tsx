import { useState } from "react";
import type { ReactNode } from "react";
import {
  CheckCircle2,
  ChevronRight,
  Circle,
  Loader2,
} from "lucide-react";
import { cn } from "@sourceweft/ui-web/lib/utils";
import type { AssistantActivityItem } from "./assistant-activity-items";
import { AssistantToolCard } from "./assistant-tool-card";
import type { ToolConfirmationResolution } from "./types";

function ActivityStatusCell({ children }: { children: ReactNode }) {
  return (
    <span className="grid size-6 shrink-0 place-items-center text-muted-foreground/80">
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
        className="flex min-h-8 w-full items-center gap-1 rounded-md px-1 py-1 text-left hover:bg-muted/30"
        disabled={!hasDetails}
        onClick={() => setIsOpen((value) => !value)}
        type="button"
      >
        <ActivityStatusCell>
          <StepStatusIcon status={item.status} />
        </ActivityStatusCell>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
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
        <div className="ml-7 space-y-1 rounded-md px-2 py-1 text-[13px] text-muted-foreground/75 leading-5">
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
  item,
}: {
  item: Extract<AssistantActivityItem, { type: "reasoning" }>;
}) {
  const duration =
    typeof item.durationMs === "number" && Number.isFinite(item.durationMs)
      ? item.durationMs < 1000
        ? `${Math.max(1, Math.round(item.durationMs))}ms`
        : `${Math.round(item.durationMs / 100) / 10}s`
      : null;

  return (
    <div className="group text-muted-foreground transition-colors hover:text-foreground">
      <div className="flex min-h-8 w-full items-center gap-1 rounded-md px-1 py-1">
        <ActivityStatusCell>
          <Circle className="size-3.5 text-muted-foreground/70" />
        </ActivityStatusCell>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="truncate text-[13px] text-foreground/80">
            {item.text}
          </span>
          {duration ? (
            <span className="shrink-0 text-muted-foreground/60 text-xs">
              {duration}
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
}

export function AssistantActivitySegment({
  item,
  onWorkfileClick,
  resolvedConfirmations,
}: {
  item: AssistantActivityItem;
  onWorkfileClick?: (path: string) => void;
  resolvedConfirmations?: ToolConfirmationResolution[];
}) {
  if (item.type === "reasoning") {
    return <AssistantReasoningRow item={item} />;
  }

  if (item.type === "step") {
    return <AssistantStepRow item={item} />;
  }

  return (
    <AssistantToolCard
      onWorkfileClick={onWorkfileClick}
      resolvedConfirmations={resolvedConfirmations}
      toolCall={item.toolCall}
      toolStep={item.toolStep}
    />
  );
}
