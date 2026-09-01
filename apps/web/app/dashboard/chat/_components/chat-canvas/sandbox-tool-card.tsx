import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
  Download,
  ListTree,
  Loader2,
  SquareTerminal,
  Upload,
} from "lucide-react";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockHeader,
} from "@sourceweft/ui-web/components/ai-elements/code-block";
import {
  Snippet,
  SnippetCopyButton,
  SnippetInput,
} from "@sourceweft/ui-web/components/ai-elements/snippet";
import {
  Task,
  TaskContent,
  TaskItem,
  TaskTrigger,
} from "@sourceweft/ui-web/components/ai-elements/task";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { formatCompactDuration } from "./duration-format";
import {
  ASSISTANT_ACTIVITY_DETAIL_CLASS,
  ASSISTANT_ACTIVITY_ICON_CLASS,
  ASSISTANT_ACTIVITY_LABEL_CLASS,
  ASSISTANT_ACTIVITY_ROW_CLASS,
} from "./assistant-activity-layout";
import { getResolvedToolConfirmationMessage } from "./reasoning-trace-state";
import {
  formatSandboxByteCount,
  getSandboxExecuteView,
  getSandboxToolOperationTimeline,
  getSandboxToolSafeErrorMessage,
  getSandboxTransferView,
  resolveSandboxToolUiState,
} from "./sandbox-tool-result-display";
import type { SandboxToolOperationTimelineItem } from "./sandbox-tool-result-display";
import { getToolConfirmationOutput } from "./tool-confirmation-state";
import type {
  ThinkingStepRecord,
  ToolCallRecord,
  ToolConfirmationResolution,
} from "./types";

const SANDBOX_TOOL_CARD_NAMES = new Set([
  "prepare_sandbox_workspace",
  "execute",
  "collect_sandbox_outputs",
]);

export function isSandboxToolCardToolName(toolName: string) {
  return SANDBOX_TOOL_CARD_NAMES.has(toolName);
}

export type SandboxToolCardProps = {
  children?: ReactNode;
  contentClassName?: string;
  defaultOpen?: boolean;
  onWorkfileClick?: (path: string) => void;
  resolvedConfirmations?: ToolConfirmationResolution[];
  toolCall: ToolCallRecord;
  toolStep?: ThinkingStepRecord;
};

function formatDuration(latencyMs: number | null) {
  if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs)) {
    return null;
  }
  if (latencyMs < 1000) {
    return `${Math.max(1, Math.round(latencyMs))}ms`;
  }
  return formatCompactDuration(latencyMs);
}

function getConfirmationDisplay(input: {
  resolvedConfirmations: ToolConfirmationResolution[];
  toolCall: ToolCallRecord;
}) {
  const confirmation = getToolConfirmationOutput(input.toolCall.output);
  const resolution = confirmation
    ? input.resolvedConfirmations.find(
        (item) => item.confirmationId === confirmation.id,
      )
    : null;
  return {
    message: getResolvedToolConfirmationMessage({
      confirmation,
      confirmationResolution: resolution,
    }),
  };
}

function outputPlaceholder(input: {
  state: ReturnType<typeof resolveSandboxToolUiState>;
  toolError: string | null;
  viewMessage: string | null;
}) {
  if (input.toolError || input.viewMessage) {
    return input.toolError ?? input.viewMessage;
  }
  switch (input.state) {
    case "approval-requested":
      return "Waiting for approval before execution.";
    case "output-denied":
      return "Execution was not approved.";
    case "input-available":
      return "Command is running. Output will appear when execution completes.";
    case "output-error":
      return "The sandbox command could not be executed.";
    default:
      return "Command completed without output.";
  }
}

function OperationStatusIcon({ status }: { status: string | null }) {
  const normalized = status?.toLowerCase();
  if (normalized === "running") {
    return <CircleDot className="size-3.5 text-primary" />;
  }
  if (normalized === "succeeded") {
    return <CheckCircle2 className="size-3.5 text-emerald-600" />;
  }
  if (
    normalized === "failed" ||
    normalized === "rejected" ||
    normalized === "canceled"
  ) {
    return <AlertTriangle className="size-3.5 text-destructive" />;
  }
  return <Clock3 className="size-3.5 text-muted-foreground" />;
}

function formatOperationTimestamp(value: string | null) {
  if (!value) {
    return null;
  }
  const isoTime = value.match(/T(\d{2}:\d{2}:\d{2})/u)?.[1];
  return isoTime ? `${isoTime} UTC` : value;
}

function SandboxOperationActivity({
  items,
}: {
  items: SandboxToolOperationTimelineItem[];
}) {
  return (
    // Borderless flat collapsible (matches the CoT/sub-agent grouping idiom);
    // the timeline items sit under TaskContent's left rule. No nested card box.
    // Collapsed by default — it's secondary detail, expand to inspect.
    <Task defaultOpen={false}>
      <TaskTrigger title="Recorded sandbox operations">
        <button
          className="flex w-full items-center gap-1.5 px-1 py-1 text-left text-muted-foreground text-sm transition-colors hover:text-foreground"
          type="button"
        >
          <ListTree className="size-3.5 text-muted-foreground/75" />
          <span className="font-medium text-foreground/80">
            Recorded operations
          </span>
          <span className="text-muted-foreground/60 text-xs">
            {items.length}
          </span>
          <ChevronRight className="ml-auto size-3.5 text-muted-foreground/50 transition-transform group-data-[state=open]:rotate-90" />
        </button>
      </TaskTrigger>
      <TaskContent>
        {items.map((item) => {
          const timestamp = formatOperationTimestamp(item.timestamp);
          return (
            <TaskItem
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2"
              key={item.key}
            >
              <span className="mt-0.5">
                <OperationStatusIcon status={item.status} />
              </span>
              <span className="min-w-0">
                <span className="block text-foreground/80">{item.label}</span>
                {item.detail ? (
                  <span className="block break-words text-xs">
                    {item.detail}
                  </span>
                ) : null}
                {item.output ? (
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 px-2 py-1 font-mono text-[11px] text-foreground/75 leading-4">
                    {item.output}
                    {item.outputTruncated ? "\n…" : ""}
                  </pre>
                ) : null}
              </span>
              {item.duration || timestamp ? (
                <span
                  className="text-right text-muted-foreground/70 text-xs"
                  title={item.timestamp ?? undefined}
                >
                  {item.duration ?? timestamp}
                </span>
              ) : null}
            </TaskItem>
          );
        })}
      </TaskContent>
    </Task>
  );
}

function sandboxToolStatusKey(
  state: ReturnType<typeof resolveSandboxToolUiState>,
) {
  switch (state) {
    case "approval-requested":
      return "needs-approval" as const;
    case "input-available":
      return "running" as const;
    case "output-denied":
      return "rejected" as const;
    case "output-error":
      return "failed" as const;
    default:
      return "done" as const;
  }
}

const SANDBOX_STATUS_LABELS = {
  done: "Done",
  failed: "Failed",
  "needs-approval": "Needs approval",
  rejected: "Rejected",
  running: "Running",
} as const;

function ExecuteStatusIcon({
  statusKey,
}: {
  statusKey: ReturnType<typeof sandboxToolStatusKey>;
}) {
  if (statusKey === "running") {
    return (
      <Loader2 className="size-3.5 animate-spin text-primary motion-reduce:animate-none" />
    );
  }
  if (statusKey === "failed") {
    return <AlertTriangle className="size-3.5 text-destructive" />;
  }
  if (statusKey === "rejected") {
    return <AlertTriangle className="size-3.5 text-orange-600" />;
  }
  if (statusKey === "needs-approval") {
    return <Clock3 className="size-3.5 text-amber-700 dark:text-amber-300" />;
  }
  return <SquareTerminal className="size-3.5 text-muted-foreground/75" />;
}

function SandboxExecuteCard({
  children,
  contentClassName,
  defaultOpen,
  resolvedConfirmations = [],
  toolCall,
  toolStep,
}: SandboxToolCardProps) {
  const view = getSandboxExecuteView({
    input: toolCall.input,
    output: toolCall.output,
    toolName: toolCall.tool,
  });
  const state = resolveSandboxToolUiState({
    approvalState: toolCall.approvalState,
    output: toolCall.output,
    status: toolCall.status,
    toolName: toolCall.tool,
  });
  const statusKey = sandboxToolStatusKey(state);
  const toolError = getSandboxToolSafeErrorMessage({
    error: toolCall.error,
    toolName: toolCall.tool,
  });
  const confirmation = getConfirmationDisplay({
    resolvedConfirmations,
    toolCall,
  });
  const effectiveDefaultOpen = defaultOpen ?? statusKey !== "done";
  const [isOpen, setIsOpen] = useState(effectiveDefaultOpen);

  useEffect(() => {
    setIsOpen(effectiveDefaultOpen);
  }, [effectiveDefaultOpen]);

  if (!view) {
    return null;
  }

  const duration = formatDuration(toolCall.latencyMs);
  const operationTimeline = getSandboxToolOperationTimeline({
    output: toolCall.output,
    toolName: toolCall.tool,
  });
  const failureMessage =
    toolError ??
    (view.resultFailed
      ? (getSandboxToolSafeErrorMessage({
          error: view.code ?? view.message,
          toolName: toolCall.tool,
        }) ?? "The sandbox command could not be executed.")
      : null);
  const hasDetails =
    Boolean(view.command) ||
    Boolean(view.output) ||
    Boolean(failureMessage) ||
    operationTimeline.length > 0 ||
    Boolean(confirmation.message) ||
    Boolean(toolStep?.detail) ||
    Boolean(children);

  return (
    <div className="group text-muted-foreground transition-colors hover:text-foreground">
      <button
        aria-expanded={hasDetails ? isOpen : undefined}
        className={ASSISTANT_ACTIVITY_ROW_CLASS}
        disabled={!hasDetails}
        onClick={() => setIsOpen((value) => !value)}
        type="button"
      >
        <span className={ASSISTANT_ACTIVITY_ICON_CLASS}>
          <ExecuteStatusIcon statusKey={statusKey} />
        </span>
        <span className={ASSISTANT_ACTIVITY_LABEL_CLASS}>
          <span className="truncate text-[13px] text-foreground/80">
            Execute sandbox command
          </span>
          {duration ? (
            <span className="shrink-0 text-muted-foreground/60 text-xs">
              {duration}
            </span>
          ) : null}
          {statusKey !== "done" ? (
            <span className="shrink-0 text-muted-foreground/60 text-xs">
              {SANDBOX_STATUS_LABELS[statusKey]}
            </span>
          ) : null}
        </span>
        {hasDetails ? (
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
      {isOpen && hasDetails ? (
        <div className={cn(ASSISTANT_ACTIVITY_DETAIL_CLASS, contentClassName)}>
          {view.command ? (
            view.command.includes("\n") ? (
              // Multi-line command (rare, e.g. a heredoc): keep a code block, but
              // drop the redundant "command" header — the card title already
              // says "Execute sandbox command".
              <CodeBlock
                className="[&_pre]:max-h-72 [&_pre]:overflow-auto"
                code={view.command}
                language="bash"
              >
                <CodeBlockHeader className="justify-end">
                  <CodeBlockActions>
                    <CodeBlockCopyButton aria-label="Copy sandbox command" />
                  </CodeBlockActions>
                </CodeBlockHeader>
              </CodeBlock>
            ) : (
              // Single-line command (the norm): a compact one-line snippet with
              // copy — the real code authoring now lives in write_file previews,
              // so the command here is just an identifiable, copyable invocation.
              <Snippet className="w-full" code={view.command}>
                <SnippetInput
                  aria-label="Sandbox command"
                  className="text-xs"
                />
                <SnippetCopyButton aria-label="Copy sandbox command" />
              </Snippet>
            )
          ) : (
            <p className="break-words">Command input is unavailable.</p>
          )}
          {failureMessage ? (
            <div
              className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-destructive text-xs"
              role="alert"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span className="break-words">{failureMessage}</span>
            </div>
          ) : null}
          {view.output ? (
            <div className="overflow-hidden rounded-md border bg-background">
              <div className="flex items-center justify-between gap-2 border-b bg-muted/80 px-3 py-1.5 text-muted-foreground text-xs">
                <span className="flex items-center gap-2">
                  <SquareTerminal className="size-3.5" />
                  <span className="font-mono">output</span>
                </span>
                <span className="flex items-center gap-2 font-mono">
                  {view.exitCode !== null ? (
                    <span
                      className={cn(
                        view.exitCode === 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-red-600 dark:text-red-400",
                      )}
                    >
                      exit {view.exitCode}
                    </span>
                  ) : null}
                  {view.truncated ? (
                    <span className="text-amber-600 dark:text-amber-400">
                      truncated
                    </span>
                  ) : null}
                </span>
              </div>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[13px] text-foreground leading-relaxed">
                {view.output}
              </pre>
            </div>
          ) : failureMessage || statusKey === "done" ? null : (
            // Only surface a placeholder for states that are actually waiting on
            // something (running / approval / denied). A finished command that
            // simply produced no output needs no "completed without output" box.
            <div className="rounded-md border border-dashed p-3 text-muted-foreground text-xs">
              {outputPlaceholder({
                state,
                toolError,
                viewMessage: view.message,
              })}
            </div>
          )}
          {view.recoverable !== null ? (
            <p className="text-muted-foreground text-xs">
              Recoverable: {view.recoverable ? "Yes" : "No"}
            </p>
          ) : null}
          {confirmation.message ? (
            <p className="break-words">{confirmation.message}</p>
          ) : null}
          {toolStep?.detail ? (
            <p className="break-words">{toolStep.detail}</p>
          ) : null}
          {operationTimeline.length > 0 ? (
            <SandboxOperationActivity items={operationTimeline} />
          ) : null}
          {children}
        </div>
      ) : null}
    </div>
  );
}

function TransferStatusIcon({
  direction,
  statusKey,
}: {
  direction: "collect" | "prepare";
  statusKey: ReturnType<typeof sandboxToolStatusKey>;
}) {
  if (statusKey === "running") {
    return (
      <Loader2 className="size-3.5 animate-spin text-primary motion-reduce:animate-none" />
    );
  }
  if (statusKey === "failed") {
    return <AlertTriangle className="size-3.5 text-destructive" />;
  }
  if (statusKey === "rejected") {
    return <AlertTriangle className="size-3.5 text-orange-600" />;
  }
  if (statusKey === "needs-approval") {
    return <Clock3 className="size-3.5 text-amber-700 dark:text-amber-300" />;
  }
  return direction === "prepare" ? (
    <Upload className="size-3.5 text-muted-foreground/75" />
  ) : (
    <Download className="size-3.5 text-muted-foreground/75" />
  );
}

function SandboxTransferCard({
  children,
  contentClassName,
  defaultOpen,
  onWorkfileClick,
  resolvedConfirmations = [],
  toolCall,
  toolStep,
}: SandboxToolCardProps) {
  const view = getSandboxTransferView({
    input: toolCall.input,
    output: toolCall.output,
    toolName: toolCall.tool,
  });
  const state = resolveSandboxToolUiState({
    approvalState: toolCall.approvalState,
    output: toolCall.output,
    status: toolCall.status,
    toolName: toolCall.tool,
  });
  const statusKey = sandboxToolStatusKey(state);
  const confirmation = getConfirmationDisplay({
    resolvedConfirmations,
    toolCall,
  });
  const toolError = getSandboxToolSafeErrorMessage({
    error: toolCall.error,
    toolName: toolCall.tool,
  });
  const effectiveDefaultOpen = defaultOpen ?? statusKey !== "done";
  const [isOpen, setIsOpen] = useState(effectiveDefaultOpen);

  useEffect(() => {
    setIsOpen(effectiveDefaultOpen);
  }, [effectiveDefaultOpen]);

  if (!view) {
    return null;
  }

  const duration = formatDuration(toolCall.latencyMs);
  const title =
    view.direction === "prepare"
      ? "Prepare sandbox workspace"
      : "Collect sandbox outputs";
  const resultMessage =
    toolError ??
    (view.resultFailed
      ? (getSandboxToolSafeErrorMessage({
          error: view.code ?? view.message,
          toolName: toolCall.tool,
        }) ?? "The sandbox file transfer could not be completed.")
      : null);
  const hasDetails =
    view.mappings.length > 0 ||
    view.totalBytes !== null ||
    Boolean(resultMessage) ||
    Boolean(view.code) ||
    Boolean(confirmation.message) ||
    Boolean(toolStep?.detail) ||
    Boolean(children);

  return (
    <div className="group text-muted-foreground transition-colors hover:text-foreground">
      <button
        aria-expanded={hasDetails ? isOpen : undefined}
        className={ASSISTANT_ACTIVITY_ROW_CLASS}
        disabled={!hasDetails}
        onClick={() => setIsOpen((value) => !value)}
        type="button"
      >
        <span className={ASSISTANT_ACTIVITY_ICON_CLASS}>
          <TransferStatusIcon
            direction={view.direction}
            statusKey={statusKey}
          />
        </span>
        <span className={ASSISTANT_ACTIVITY_LABEL_CLASS}>
          <span className="truncate text-[13px] text-foreground/80">
            {title}
          </span>
          {duration ? (
            <span className="shrink-0 text-muted-foreground/60 text-xs">
              {duration}
            </span>
          ) : null}
          {statusKey !== "done" ? (
            <span className="shrink-0 text-muted-foreground/60 text-xs">
              {SANDBOX_STATUS_LABELS[statusKey]}
            </span>
          ) : null}
        </span>
        {hasDetails ? (
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
      {isOpen && hasDetails ? (
        <div className={cn(ASSISTANT_ACTIVITY_DETAIL_CLASS, contentClassName)}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span>
              {view.mappings.length} {view.resultSucceeded ? null : "planned "}
              {view.mappings.length === 1 ? "file" : "files"}
            </span>
            {view.totalBytes !== null ? (
              <span>{formatSandboxByteCount(view.totalBytes)}</span>
            ) : null}
            {view.recoverable !== null ? (
              <span>Recoverable: {view.recoverable ? "Yes" : "No"}</span>
            ) : null}
          </div>
          {view.mappings.length > 0 ? (
            <div className="max-h-80 space-y-1.5 overflow-auto rounded-md border border-border/60 bg-muted/20 p-1.5">
              {view.mappings.map((mapping) => {
                const canOpenTarget =
                  view.direction === "collect" &&
                  view.resultSucceeded &&
                  mapping.target.startsWith("/workfiles/") &&
                  Boolean(onWorkfileClick);
                return (
                  <div
                    className="grid gap-1 rounded-sm bg-background/70 p-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] sm:items-center"
                    key={mapping.key}
                  >
                    <div className="min-w-0">
                      <span className="block text-[10px] text-muted-foreground/60 uppercase tracking-wide">
                        From
                      </span>
                      <code
                        className="block truncate text-foreground/75"
                        title={mapping.source}
                      >
                        {mapping.source}
                      </code>
                    </div>
                    <ArrowRight className="hidden size-3.5 text-muted-foreground/50 sm:block" />
                    <div className="min-w-0">
                      <span className="block text-[10px] text-muted-foreground/60 uppercase tracking-wide">
                        To
                      </span>
                      {canOpenTarget ? (
                        <button
                          className="block max-w-full truncate text-left text-primary underline-offset-2 hover:underline"
                          onClick={() => onWorkfileClick?.(mapping.target)}
                          title={mapping.target}
                          type="button"
                        >
                          {mapping.target}
                        </button>
                      ) : (
                        <code
                          className="block truncate text-foreground/75"
                          title={mapping.target}
                        >
                          {mapping.target}
                        </code>
                      )}
                    </div>
                    {mapping.sizeBytes !== null ? (
                      <span className="text-muted-foreground/60 text-xs">
                        {formatSandboxByteCount(mapping.sizeBytes)}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
          {confirmation.message ? (
            <p className="break-words">{confirmation.message}</p>
          ) : null}
          {toolStep?.detail ? (
            <p className="break-words">{toolStep.detail}</p>
          ) : null}
          {view.code ? (
            <p className="break-words text-destructive">{view.code}</p>
          ) : null}
          {resultMessage ? (
            <p className="break-words text-destructive" role="alert">
              {resultMessage}
            </p>
          ) : null}
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function SandboxToolCard(props: SandboxToolCardProps) {
  if (props.toolCall.tool === "execute") {
    return <SandboxExecuteCard {...props} />;
  }
  return <SandboxTransferCard {...props} />;
}
