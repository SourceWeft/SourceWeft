"use client";

import { Bot, ChevronDown, Loader2 } from "lucide-react";
import {
  Task,
  TaskContent,
  TaskItem,
  TaskTrigger,
} from "@sourceweft/ui-web/components/ai-elements/task";
import { MessageResponse } from "@sourceweft/ui-web/components/ai-elements/message";
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
      <TaskTrigger title={`Delegated to ${view.subagentType}`}>
        <div className="flex w-full cursor-pointer items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground">
          {view.status === "running" ? (
            <Loader2 className="size-4 animate-spin text-primary motion-reduce:animate-none" />
          ) : (
            <Bot className="size-4" />
          )}
          <p className="text-sm">
            Delegated to {view.subagentType} · {STATUS_LABEL[view.status]}
          </p>
          <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
        </div>
      </TaskTrigger>
      <TaskContent>
        {view.prompt.length > 0 ? <TaskItem>{view.prompt}</TaskItem> : null}
        {view.report ? (
          <TaskItem>
            <MessageResponse>{view.report}</MessageResponse>
          </TaskItem>
        ) : view.status === "running" ? (
          <TaskItem>Working…</TaskItem>
        ) : null}
      </TaskContent>
    </Task>
  );
}
