import { useState, type ReactNode } from "react";
import { ChevronRight, Layers, Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Shimmer } from "@sourceweft/ui-web/components/ai-elements/shimmer";
import { cn } from "@sourceweft/ui-web/lib/utils";
import {
  ASSISTANT_ACTIVITY_ICON_CLASS,
  ASSISTANT_ACTIVITY_LABEL_CLASS,
  ASSISTANT_ACTIVITY_ROW_CLASS,
} from "./assistant-activity-layout";
import { getAssistantToolTitle } from "./assistant-tool-display";
import { isSandboxToolResultFailure } from "./sandbox-tool-result-display";
import type { WorkflowBlockEntry } from "./subagent-grouping";
import { summarizeToolGroup } from "./tool-group-summary";
import type { ToolCallRecord } from "./types";

function isFailedToolCall(toolCall: ToolCallRecord) {
  return (
    toolCall.status === "error" ||
    isSandboxToolResultFailure({
      output: toolCall.output,
      toolName: toolCall.tool,
    })
  );
}

/**
 * A run of tool calls shown as one summary row ("Used Gmail, read 3 files,
 * and ran a command"). It stays open while the run is live or when a call
 * failed, and folds away once the run finishes cleanly.
 */
export function WorkflowToolGroup({
  entries,
  isRunning,
  renderEntry,
  resolveToolCall,
}: {
  entries: WorkflowBlockEntry[];
  isRunning: boolean;
  renderEntry: (entry: WorkflowBlockEntry) => ReactNode;
  resolveToolCall: (entry: WorkflowBlockEntry) => ToolCallRecord | undefined;
}) {
  const t = useTranslations("dashboardChatCanvas");
  const locale = useLocale();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);

  const toolCalls = entries
    .map(resolveToolCall)
    .filter((toolCall): toolCall is ToolCallRecord => Boolean(toolCall));
  const failedCount = toolCalls.filter(isFailedToolCall).length;
  const runningToolCall = [...toolCalls]
    .reverse()
    .find((toolCall) => toolCall.status === "running");
  const isLive = isRunning || Boolean(runningToolCall);
  const isOpen = userOpen ?? (isLive || failedCount > 0);
  const label = runningToolCall
    ? getAssistantToolTitle(runningToolCall, t)
    : summarizeToolGroup({ locale, t, toolCalls });

  return (
    <div data-tool-group="true">
      <button
        aria-expanded={isOpen}
        className={cn(
          ASSISTANT_ACTIVITY_ROW_CLASS,
          "group text-muted-foreground transition-colors hover:text-foreground",
        )}
        onClick={() => setUserOpen(!isOpen)}
        type="button"
      >
        <span className={ASSISTANT_ACTIVITY_ICON_CLASS}>
          {isLive ? (
            <Loader2 className="size-3.5 animate-spin text-primary motion-reduce:animate-none" />
          ) : (
            <Layers className="size-3.5 text-muted-foreground/75" />
          )}
        </span>
        <span className={ASSISTANT_ACTIVITY_LABEL_CLASS}>
          <span
            className="truncate text-[13px] text-foreground/80"
            title={label}
          >
            {runningToolCall ? (
              <Shimmer duration={1}>{label}</Shimmer>
            ) : (
              label
            )}
          </span>
          {failedCount > 0 ? (
            <span className="shrink-0 text-destructive text-xs">
              <span aria-hidden="true">· </span>
              {t("toolGroup.failed", { count: failedCount })}
            </span>
          ) : null}
        </span>
        <span className="grid size-4 shrink-0 place-items-center">
          <ChevronRight
            className={cn(
              "size-3 text-muted-foreground/50 transition-transform",
              isOpen && "rotate-90",
            )}
          />
        </span>
      </button>
      {isOpen ? (
        <div className="space-y-1">
          {entries.map((entry) => (
            <div key={entry.block.id}>{renderEntry(entry)}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
