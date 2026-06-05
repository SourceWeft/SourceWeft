import { useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Loader2,
} from "lucide-react";
import { getAgentToolSlashCommand } from "@sourceweft/sdk";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { compactText, getToolOutputContent } from "./message-assets";
import {
  getConnectorToolDisplayLabel,
  getResolvedToolConfirmationMessage,
  getToolApprovalDisplayLabel,
  getToolCallDetailParts,
  isToolConfirmationResolved,
} from "./reasoning-trace-state";
import {
  getSandboxCollectedWorkfilePaths,
  getSandboxToolOperationTimeline,
  getSandboxToolResultDetails,
  getSandboxToolResultSummary,
  getSandboxToolSafeErrorMessage,
} from "./sandbox-tool-result-display";
import type { SandboxToolOperationTimelineItem } from "./sandbox-tool-result-display";
import { getToolConfirmationOutput } from "./tool-confirmation-state";
import type {
  ThinkingStepRecord,
  ToolCallRecord,
  ToolConfirmationResolution,
} from "./types";

function formatToolName(toolName: string) {
  return toolName
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function getToolDisplayName(toolName: string) {
  return (
    getAgentToolSlashCommand(toolName)?.displayName ?? formatToolName(toolName)
  );
}

function getToolTitle(
  toolCall: ToolCallRecord,
  confirmationResolution?: ToolConfirmationResolution | null,
) {
  const title =
    getToolApprovalDisplayLabel(toolCall, confirmationResolution) ??
    getConnectorToolDisplayLabel(toolCall) ??
    getToolDisplayName(toolCall.tool);

  return title
    .replace(/\s+(completed|done|running|failed|errored)$/i, "")
    .trim();
}

function getStatusLabel(input: {
  confirmationResolution?: ToolConfirmationResolution | null;
  toolCall: ToolCallRecord;
}) {
  if (input.toolCall.approvalState === "rejected") {
    return "Rejected";
  }
  const confirmation = getToolConfirmationOutput(input.toolCall.output);
  if (
    confirmation &&
    !isToolConfirmationResolved({
      confirmation,
      confirmationResolution: input.confirmationResolution,
    })
  ) {
    return "Needs approval";
  }
  if (input.toolCall.status === "running") {
    return "Running";
  }
  if (input.toolCall.status === "approval_requested") {
    return "Needs approval";
  }
  if (input.toolCall.status === "error") {
    return "Failed";
  }
  return "Done";
}

function StatusIcon({ label }: { label: string }) {
  if (label === "Running") {
    return (
      <Loader2 className="size-3.5 animate-spin text-primary motion-reduce:animate-none" />
    );
  }
  if (label === "Failed") {
    return <AlertTriangle className="size-3.5 text-destructive" />;
  }
  if (label === "Rejected") {
    return <AlertTriangle className="size-3.5 text-orange-600" />;
  }
  if (label === "Needs approval") {
    return <Clock3 className="size-3.5 text-amber-700 dark:text-amber-300" />;
  }
  return (
    <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />
  );
}

function formatToolDuration(latencyMs: number | null | undefined) {
  if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs)) {
    return null;
  }
  if (latencyMs < 1000) {
    return `${Math.max(1, Math.round(latencyMs))}ms`;
  }
  const seconds = latencyMs / 1000;
  return `${seconds >= 10 ? Math.round(seconds) : seconds.toFixed(1)}s`;
}

function getOutputSummary(toolCall: ToolCallRecord) {
  const confirmation = getToolConfirmationOutput(toolCall.output);
  if (confirmation) {
    return null;
  }
  const sandboxSummary = getSandboxToolResultSummary({
    output: toolCall.output,
    toolName: toolCall.tool,
  });
  if (sandboxSummary) {
    return compactText(sandboxSummary, 220);
  }
  const content = getToolOutputContent(toolCall.output);
  return content && content !== "{}" ? compactText(content, 220) : null;
}

function SandboxOperationTimeline({
  items,
}: {
  items: SandboxToolOperationTimelineItem[];
}) {
  return (
    <div className="space-y-1">
      <p className="font-medium text-foreground/70">Sandbox timeline</p>
      <ol className="space-y-1 border-muted/60 border-l pl-3">
        {items.map((item) => (
          <li className="relative" key={item.key}>
            <span className="-left-[15px] absolute mt-2 size-1.5 rounded-full bg-muted-foreground/40" />
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <span className="text-foreground/80">{item.label}</span>
              {item.status ? (
                <span className="text-muted-foreground/60 text-xs">
                  {item.status}
                </span>
              ) : null}
              {item.duration ? (
                <span className="text-muted-foreground/60 text-xs">
                  {item.duration}
                </span>
              ) : null}
            </div>
            {item.detail ? (
              <p className="break-words text-muted-foreground/75">
                {item.detail}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function AssistantToolCard({
  children,
  contentClassName,
  defaultOpen,
  onWorkfileClick,
  resolvedConfirmations = [],
  toolCall,
  toolStep,
}: {
  children?: ReactNode;
  contentClassName?: string;
  defaultOpen?: boolean;
  onWorkfileClick?: (path: string) => void;
  resolvedConfirmations?: ToolConfirmationResolution[];
  toolCall: ToolCallRecord;
  toolStep?: ThinkingStepRecord;
}) {
  const confirmation = getToolConfirmationOutput(toolCall.output);
  const confirmationResolution = confirmation
    ? resolvedConfirmations.find(
        (item) => item.confirmationId === confirmation.id,
      )
    : null;
  const statusLabel = getStatusLabel({ confirmationResolution, toolCall });
  const title = getToolTitle(toolCall, confirmationResolution);
  const detailParts = getToolCallDetailParts(
    toolCall,
    toolStep,
    confirmationResolution,
  );
  const outputSummary = getOutputSummary(toolCall);
  const collectedWorkfilePaths = getSandboxCollectedWorkfilePaths({
    output: toolCall.output,
    toolName: toolCall.tool,
  });
  const sandboxDetails = getSandboxToolResultDetails({
    output: toolCall.output,
    toolName: toolCall.tool,
  });
  const sandboxTimeline = getSandboxToolOperationTimeline({
    output: toolCall.output,
    toolName: toolCall.tool,
  });
  const toolError = getSandboxToolSafeErrorMessage({
    error: toolCall.error,
    toolName: toolCall.tool,
  });
  const duration = formatToolDuration(toolCall.latencyMs);
  const visibleStatus = statusLabel === "Done" ? null : statusLabel;
  const resolvedConfirmationMessage = getResolvedToolConfirmationMessage({
    confirmation,
    confirmationResolution,
  });
  const [isOpen, setIsOpen] = useState(
    defaultOpen ??
      (toolCall.status === "error" ||
        statusLabel === "Needs approval" ||
        statusLabel === "Rejected"),
  );
  const hasDetails =
    detailParts.length > 0 ||
    Boolean(outputSummary) ||
    sandboxDetails.length > 0 ||
    sandboxTimeline.length > 0 ||
    collectedWorkfilePaths.length > 0 ||
    Boolean(toolStep?.detail) ||
    Boolean(toolError) ||
    Boolean(resolvedConfirmationMessage);
  const hasExpandableContent = hasDetails || Boolean(children);

  return (
    <div className="group text-muted-foreground transition-colors hover:text-foreground">
      <button
        aria-expanded={hasExpandableContent ? isOpen : undefined}
        className="flex min-h-8 w-full items-center gap-1 rounded-md px-1 py-1 text-left hover:bg-muted/30"
        disabled={!hasExpandableContent}
        onClick={() => setIsOpen((value) => !value)}
        type="button"
      >
        <span className="grid size-6 shrink-0 place-items-center">
          <StatusIcon label={statusLabel} />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span
            className="truncate text-[13px] text-foreground/80"
            title={title}
          >
            {title}
          </span>
          {duration ? (
            <span className="shrink-0 text-muted-foreground/60 text-xs">
              {duration}
            </span>
          ) : null}
          {visibleStatus ? (
            <span className="shrink-0 text-muted-foreground/60 text-xs">
              {visibleStatus}
            </span>
          ) : null}
        </span>
        {hasExpandableContent ? (
          <span className="grid size-4 shrink-0 place-items-center">
            <ChevronRight
              className={cn(
                "size-3 text-muted-foreground/50 transition-transform",
                isOpen && "rotate-90",
              )}
            />
          </span>
        ) : null}
      </button>
      {isOpen && hasExpandableContent ? (
        <div
          className={cn(
            "ml-7 space-y-1.5 rounded-md px-2 py-1 text-[13px] text-muted-foreground/75 leading-5",
            contentClassName,
          )}
        >
          {hasDetails && detailParts.length > 0 ? (
            <p className="break-words">{detailParts.join(" · ")}</p>
          ) : null}
          {hasDetails && toolStep?.detail ? (
            <p className="break-words">{toolStep.detail}</p>
          ) : null}
          {hasDetails && resolvedConfirmationMessage ? (
            <p className="break-words">{resolvedConfirmationMessage}</p>
          ) : null}
          {hasDetails && outputSummary ? (
            <p className="break-words">{outputSummary}</p>
          ) : null}
          {hasDetails && sandboxDetails.length > 0 ? (
            <dl className="grid gap-1">
              {sandboxDetails.map((detail) => (
                <div className="grid gap-0.5" key={detail.label}>
                  <dt className="font-medium text-foreground/70">
                    {detail.label}
                  </dt>
                  <dd className="break-words">{detail.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {hasDetails && sandboxTimeline.length > 0 ? (
            <SandboxOperationTimeline items={sandboxTimeline} />
          ) : null}
          {hasDetails && collectedWorkfilePaths.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {collectedWorkfilePaths.map((path) => (
                <button
                  className="max-w-[260px] truncate rounded-md bg-primary/10 px-1.5 py-0.5 text-primary underline-offset-2 hover:underline disabled:cursor-default disabled:text-muted-foreground disabled:no-underline"
                  disabled={!onWorkfileClick}
                  key={path}
                  onClick={() => onWorkfileClick?.(path)}
                  title={path}
                  type="button"
                >
                  {path}
                </button>
              ))}
            </div>
          ) : null}
          {hasDetails && toolError ? (
            <p className="break-words text-destructive">{toolError}</p>
          ) : null}
          {children}
        </div>
      ) : null}
    </div>
  );
}
