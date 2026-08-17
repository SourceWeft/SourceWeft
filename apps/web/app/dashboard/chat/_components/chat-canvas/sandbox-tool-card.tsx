import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Download,
  FileCode2,
  ListTree,
  Loader2,
  Upload,
} from "lucide-react";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@sourceweft/ui-web/components/ai-elements/code-block";
import {
  Sandbox,
  SandboxContent,
  SandboxHeader,
  SandboxTabContent,
  SandboxTabs,
  SandboxTabsBar,
  SandboxTabsList,
  SandboxTabsTrigger,
} from "@sourceweft/ui-web/components/ai-elements/sandbox";
import {
  Terminal,
  TerminalActions,
  TerminalContent,
  TerminalCopyButton,
  TerminalHeader,
  TerminalTitle,
} from "@sourceweft/ui-web/components/ai-elements/terminal";
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
    return <Loader2 className="size-3.5 animate-spin text-primary" />;
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
    <Task
      className="rounded-md border border-border/60 bg-muted/15"
      defaultOpen
    >
      <TaskTrigger title="Recorded sandbox operations">
        <button
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted-foreground text-sm transition-colors hover:text-foreground"
          type="button"
        >
          <ListTree className="size-4" />
          <span className="font-medium text-foreground/80">
            Recorded operations
          </span>
          <span className="text-xs">{items.length}</span>
          <ChevronRight className="ml-auto size-3.5 transition-transform group-data-[state=open]:rotate-90" />
        </button>
      </TaskTrigger>
      <TaskContent className="px-3 pb-3">
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
  const toolError = getSandboxToolSafeErrorMessage({
    error: toolCall.error,
    toolName: toolCall.tool,
  });
  const confirmation = getConfirmationDisplay({
    resolvedConfirmations,
    toolCall,
  });
  const preferredTab =
    state === "approval-requested" ||
    state === "input-available" ||
    state === "output-denied"
      ? "command"
      : "output";
  const [activeTab, setActiveTab] = useState(preferredTab);
  const [isOpen, setIsOpen] = useState(defaultOpen ?? true);

  useEffect(() => {
    setActiveTab(preferredTab);
  }, [preferredTab]);

  useEffect(() => {
    setIsOpen(defaultOpen ?? true);
  }, [defaultOpen]);

  if (!view) {
    return null;
  }

  const duration = formatDuration(toolCall.latencyMs);
  const operationTimeline = getSandboxToolOperationTimeline({
    output: toolCall.output,
    toolName: toolCall.tool,
  });
  const title = duration
    ? `Execute sandbox command · ${duration}`
    : "Execute sandbox command";
  const failureMessage =
    toolError ??
    (view.resultFailed
      ? (getSandboxToolSafeErrorMessage({
          error: view.code ?? view.message,
          toolName: toolCall.tool,
        }) ?? "The sandbox command could not be executed.")
      : null);

  return (
    <Sandbox className="mb-1" onOpenChange={setIsOpen} open={isOpen}>
      <SandboxHeader state={state} title={title} />
      <SandboxContent className={contentClassName}>
        <SandboxTabs onValueChange={setActiveTab} value={activeTab}>
          <SandboxTabsBar>
            <SandboxTabsList>
              <SandboxTabsTrigger value="command">Command</SandboxTabsTrigger>
              <SandboxTabsTrigger value="output">Output</SandboxTabsTrigger>
              {operationTimeline.length > 0 ? (
                <SandboxTabsTrigger value="activity">
                  Activity
                </SandboxTabsTrigger>
              ) : null}
            </SandboxTabsList>
          </SandboxTabsBar>
          <SandboxTabContent className="space-y-3 p-3" value="command">
            {view.command ? (
              <CodeBlock
                className="[&_pre]:max-h-80 [&_pre]:overflow-auto"
                code={view.command}
                language="bash"
              >
                <CodeBlockHeader>
                  <CodeBlockTitle>
                    <FileCode2 className="size-3.5" />
                    <CodeBlockFilename>command</CodeBlockFilename>
                  </CodeBlockTitle>
                  <CodeBlockActions>
                    <CodeBlockCopyButton aria-label="Copy sandbox command" />
                  </CodeBlockActions>
                </CodeBlockHeader>
              </CodeBlock>
            ) : (
              <p className="text-muted-foreground text-sm">
                Command input is unavailable.
              </p>
            )}
            {confirmation.message ? (
              <p className="text-muted-foreground text-sm">
                {confirmation.message}
              </p>
            ) : null}
            {toolStep?.detail ? (
              <p className="break-words text-muted-foreground text-sm">
                {toolStep.detail}
              </p>
            ) : null}
          </SandboxTabContent>
          <SandboxTabContent className="space-y-3 p-3" value="output">
            {failureMessage ? (
              <div
                className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-destructive text-sm"
                role="alert"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span className="break-words">{failureMessage}</span>
              </div>
            ) : null}
            {view.output ? (
              <Terminal className="rounded-md" output={view.output}>
                <TerminalHeader>
                  <TerminalTitle>Command output</TerminalTitle>
                  <div className="flex min-w-0 items-center gap-2">
                    {view.exitCode !== null ? (
                      <span
                        className={cn(
                          "text-xs",
                          view.exitCode === 0
                            ? "text-emerald-400"
                            : "text-red-400",
                        )}
                      >
                        Exit {view.exitCode}
                      </span>
                    ) : null}
                    {view.truncated ? (
                      <span className="text-amber-300 text-xs">Truncated</span>
                    ) : null}
                    <TerminalActions>
                      <TerminalCopyButton aria-label="Copy sandbox output" />
                    </TerminalActions>
                  </div>
                </TerminalHeader>
                <TerminalContent />
              </Terminal>
            ) : failureMessage ? null : (
              <div className="rounded-md border border-dashed p-4 text-muted-foreground text-sm">
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
          </SandboxTabContent>
          {operationTimeline.length > 0 ? (
            <SandboxTabContent className="p-3" value="activity">
              <SandboxOperationActivity items={operationTimeline} />
            </SandboxTabContent>
          ) : null}
        </SandboxTabs>
        {children ? (
          <div className="space-y-1 border-t p-3">{children}</div>
        ) : null}
      </SandboxContent>
    </Sandbox>
  );
}

function transferStatusKey(
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

function TransferStatusIcon({
  direction,
  statusKey,
}: {
  direction: "collect" | "prepare";
  statusKey: ReturnType<typeof transferStatusKey>;
}) {
  if (statusKey === "running") {
    return <Loader2 className="size-3.5 animate-spin text-primary" />;
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

const TRANSFER_STATUS_LABELS = {
  done: "Done",
  failed: "Failed",
  "needs-approval": "Needs approval",
  rejected: "Rejected",
  running: "Running",
} as const;

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
  const statusKey = transferStatusKey(state);
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
              {TRANSFER_STATUS_LABELS[statusKey]}
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
