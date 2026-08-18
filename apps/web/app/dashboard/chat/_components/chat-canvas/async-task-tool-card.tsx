"use client";

import { Bot, ChevronDown, Loader2 } from "lucide-react";
import {
  Task,
  TaskContent,
  TaskItem,
  TaskTrigger,
} from "@sourceweft/ui-web/components/ai-elements/task";
import type { ToolCallRecord } from "./types";
import {
  parseAsyncTaskToolCall,
  type AsyncTaskToolView,
  type AsyncTaskVerb,
} from "./async-task-tool-card-state";

const STATUS_LABEL: Record<ToolCallRecord["status"], string> = {
  running: "Running",
  approval_requested: "Awaiting approval",
  completed: "Completed",
  error: "Failed",
};

function title(view: AsyncTaskToolView): string {
  const verbTitle: Record<AsyncTaskVerb, string> = {
    start: `Launched background ${view.agentName ?? "delegate"}`,
    check: "Checked background task",
    update: "Sent instructions to background task",
    cancel: "Cancelled background task",
    list: "Listed background tasks",
  };
  const base = verbTitle[view.verb];
  // For a status check, the delegate's own live status is the useful signal.
  if (view.verb === "check" && view.reportedStatus) {
    return `${base} · ${view.reportedStatus}`;
  }
  return `${base} · ${STATUS_LABEL[view.status]}`;
}

/**
 * Renders a deepagents async task tool call (start / check / update / cancel /
 * list) as a background-delegate card, driven by the tool call already on the
 * main stream. The background delegate's own internal steps aren't streamed
 * inline; its brief, live status, and result are surfaced here as they arrive.
 */
export function AsyncTaskToolCard({ toolCall }: { toolCall: ToolCallRecord }) {
  const view = parseAsyncTaskToolCall(toolCall);

  return (
    <Task>
      <TaskTrigger title={title(view)}>
        <div className="flex w-full cursor-pointer items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground">
          {view.status === "running" || view.reportedStatus === "running" ? (
            <Loader2 className="size-4 animate-spin text-primary motion-reduce:animate-none" />
          ) : (
            <Bot className="size-4" />
          )}
          <p className="text-sm">{title(view)}</p>
          <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
        </div>
      </TaskTrigger>
      <TaskContent>
        {view.instructions ? <TaskItem>{view.instructions}</TaskItem> : null}
        {view.verb === "check" ? (
          view.result ? (
            <TaskItem>{view.result}</TaskItem>
          ) : view.reportedStatus === "running" ? (
            <TaskItem>Still working in the background…</TaskItem>
          ) : null
        ) : null}
        {view.listing ? <TaskItem>{view.listing}</TaskItem> : null}
        {view.taskId ? (
          <TaskItem>
            <span className="text-muted-foreground/70 text-xs">
              task {view.taskId}
            </span>
          </TaskItem>
        ) : null}
      </TaskContent>
    </Task>
  );
}
