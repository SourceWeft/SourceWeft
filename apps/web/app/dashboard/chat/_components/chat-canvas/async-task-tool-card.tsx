"use client";

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
      <TaskTrigger title={title(view)} />
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
