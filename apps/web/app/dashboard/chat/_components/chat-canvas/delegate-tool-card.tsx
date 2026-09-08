"use client";

import Link from "next/link";
import { Bot, ChevronDown, ExternalLink, Loader2 } from "lucide-react";
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

const LINK_CLASS =
  "inline-flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:underline";

/**
 * Where a finished delegate's run lives on its own: the child thread the
 * server projected it into. A thread is its own route, so "open" navigates and
 * "new window" is just that route in a fresh window.
 */
export function DelegateThreadLinks({
  childThreadId,
}: {
  childThreadId: string;
}) {
  const href = `/dashboard/chat/${encodeURIComponent(childThreadId)}`;
  return (
    <div className="flex flex-wrap items-center gap-3 pl-1">
      <Link className={LINK_CLASS} href={href} title="Open sub-agent thread">
        <Bot className="size-3.5" />
        <span>Open sub-agent thread</span>
      </Link>
      <button
        className={LINK_CLASS}
        onClick={() => window.open(href, "_blank", "noopener,noreferrer")}
        title="Open in new window"
        type="button"
      >
        <ExternalLink className="size-3.5" />
        <span>New window</span>
      </button>
    </div>
  );
}

/**
 * Renders a `task` tool call as a sub-agent delegation card, driven entirely by
 * the tool call already on the main stream (args + result). The child's live
 * internal steps are not streamed (that would require fragile subgraph
 * streaming); the delegate, its brief, its returned report — and, once the run
 * has been projected, a link to the child thread it can be continued in — are.
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
        {view.childThreadId ? (
          <TaskItem>
            <DelegateThreadLinks childThreadId={view.childThreadId} />
          </TaskItem>
        ) : null}
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
