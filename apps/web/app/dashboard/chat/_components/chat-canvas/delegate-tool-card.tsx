"use client";

import {
  Task,
  TaskContent,
  TaskItem,
  TaskTrigger,
} from "@sourceweft/ui-web/components/ai-elements/task";
import type { ToolCallRecord } from "./types";
import { parseDelegateToolCall } from "./delegate-tool-card-state";

const STATUS_LABEL: Record<ToolCallRecord["status"], string> = {
  running: "Running",
  approval_requested: "Awaiting approval",
  completed: "Completed",
  error: "Failed",
};

/**
 * Renders a `task` tool call as a sub-agent delegation card, driven entirely by
 * the tool call already on the main stream (args + result). The child's live
 * internal steps are not streamed (that would require fragile subgraph
 * streaming); the delegate, its brief, and its returned report are.
 */
export function DelegateToolCard({ toolCall }: { toolCall: ToolCallRecord }) {
  const view = parseDelegateToolCall(toolCall);

  return (
    <Task>
      <TaskTrigger
        title={`Delegated to ${view.subagentType} · ${STATUS_LABEL[view.status]}`}
      />
      <TaskContent>
        {view.prompt.length > 0 ? (
          <TaskItem>{view.prompt}</TaskItem>
        ) : null}
        {view.report ? (
          <TaskItem>{view.report}</TaskItem>
        ) : view.status === "running" ? (
          <TaskItem>Working…</TaskItem>
        ) : null}
      </TaskContent>
    </Task>
  );
}
