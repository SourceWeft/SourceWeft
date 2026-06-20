import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  ChevronRight,
  Clock3,
  FileCode2,
  FilePenLine,
  FileSearch,
  FolderOpen,
  Globe,
  ImageIcon,
  Loader2,
  ScrollText,
  Search,
  TerminalSquare,
  Wrench,
} from "lucide-react";
import { cn } from "@sourceweft/ui-web/lib/utils";
import {
  ASSISTANT_ACTIVITY_DETAIL_CLASS,
  ASSISTANT_ACTIVITY_ICON_CLASS,
  ASSISTANT_ACTIVITY_LABEL_CLASS,
  ASSISTANT_ACTIVITY_ROW_CLASS,
} from "./assistant-activity-layout";
import { resolveAssistantToolCardDefaultOpen } from "./assistant-tool-card-state";
import { compactText, getToolOutputContent } from "./message-assets";
import {
  getResolvedToolConfirmationMessage,
  getToolCallDetailParts,
  isToolConfirmationResolved,
} from "./reasoning-trace-state";
import {
  getAssistantToolTitle,
  getSkillInstructionReadFileLabel,
  isRedactedSkillInstructionRead,
} from "./assistant-tool-display";
import {
  getReadFileBinaryUnsupported,
  getReadFilePreview,
  type ReadFileBinaryUnsupported,
  type ReadFilePreview,
} from "./read-file-preview";
import { WorkfileMutationPreview } from "./workfile-mutation-preview";
import { resolveWorkfileMutationPreview } from "./workfile-mutation-state";
import {
  getSandboxCollectedWorkfilePaths,
  getSandboxToolOperationTimeline,
  getSandboxToolResultDetails,
  getSandboxToolResultSummary,
  getSandboxToolSafeErrorMessage,
  isSandboxToolResultFailure,
} from "./sandbox-tool-result-display";
import type { SandboxToolOperationTimelineItem } from "./sandbox-tool-result-display";
import { getToolConfirmationOutput } from "./tool-confirmation-state";
import type {
  ThinkingStepRecord,
  ToolCallRecord,
  ToolConfirmationResolution,
} from "./types";

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
  if (
    isSandboxToolResultFailure({
      output: input.toolCall.output,
      toolName: input.toolCall.tool,
    })
  ) {
    return "Failed";
  }
  return "Done";
}

function ToolTypeIcon({ toolName }: { toolName: string }) {
  switch (toolName) {
    case "ls":
      return <FolderOpen className="size-3.5 text-muted-foreground/75" />;
    case "read_file":
      return <ScrollText className="size-3.5 text-muted-foreground/75" />;
    case "glob":
      return <FileSearch className="size-3.5 text-muted-foreground/75" />;
    case "grep":
      return <Search className="size-3.5 text-muted-foreground/75" />;
    case "write_file":
      return <FilePenLine className="size-3.5 text-muted-foreground/75" />;
    case "edit_file":
      return <FileCode2 className="size-3.5 text-muted-foreground/75" />;
    case "execute":
      return <TerminalSquare className="size-3.5 text-muted-foreground/75" />;
    case "web_fetch":
    case "web_search":
      return <Globe className="size-3.5 text-muted-foreground/75" />;
    case "generate_image":
      return <ImageIcon className="size-3.5 text-muted-foreground/75" />;
    default:
      if (
        toolName.startsWith("search_notion") ||
        toolName.startsWith("read_notion") ||
        toolName.startsWith("create_notion") ||
        toolName.startsWith("append_notion") ||
        toolName.startsWith("update_notion") ||
        toolName.startsWith("delete_notion")
      ) {
        return <FileSearch className="size-3.5 text-muted-foreground/75" />;
      }
      return <Wrench className="size-3.5 text-muted-foreground/75" />;
  }
}

function StatusIcon({ label, toolName }: { label: string; toolName: string }) {
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
  return <ToolTypeIcon toolName={toolName} />;
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
  if (isRedactedSkillInstructionRead(toolCall)) {
    return null;
  }
  if (getReadFilePreview(toolCall)) {
    return null;
  }
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

function ReadFilePreviewDetails({ preview }: { preview: ReadFilePreview }) {
  const pathLabel = preview.path ?? preview.fileName ?? "unknown file";
  const fileLabel =
    preview.fileName && preview.path && preview.fileName !== preview.path
      ? `${preview.path} (${preview.fileName})`
      : pathLabel;

  return (
    <div className="space-y-1.5">
      <p className="break-words">
        Read file: <span className="text-foreground/75">{fileLabel}</span>
      </p>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/35 px-2 py-1.5 font-mono text-[12px] text-foreground/80 leading-5">
        {preview.lines.join("\n")}
      </pre>
      {preview.isTruncated ? (
        <p className="text-muted-foreground/65 text-xs">
          Preview truncated to {preview.lineLimit} lines.
        </p>
      ) : null}
    </div>
  );
}

function ReadFileBinaryUnsupportedDetails({
  unsupported,
}: {
  unsupported: ReadFileBinaryUnsupported;
}) {
  const pathLabel = unsupported.path ?? "this file";
  const message = `${pathLabel} is not a UTF-8 text file. Use artifact preview, media-aware inspection, or publish it as an artifact instead of read_file.`;
  return (
    <p className="break-words text-muted-foreground/80">
      {message}
    </p>
  );
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
  const title = getAssistantToolTitle(
    toolCall,
    toolStep,
    confirmationResolution,
  );
  const isRedactedSkillRead = isRedactedSkillInstructionRead(toolCall);
  const skillReadFileLabel = isRedactedSkillRead
    ? getSkillInstructionReadFileLabel(toolCall)
    : null;
  const readFilePreview = isRedactedSkillRead
    ? null
    : getReadFilePreview(toolCall);
  const readFileBinaryUnsupported = isRedactedSkillRead
    ? null
    : getReadFileBinaryUnsupported(toolCall);
  const workfileMutationPreview = isRedactedSkillRead
    ? null
    : resolveWorkfileMutationPreview(toolCall);
  const detailParts = isRedactedSkillRead
    ? []
    : getToolCallDetailParts(toolCall, toolStep, confirmationResolution);
  const outputSummary = getOutputSummary(toolCall);
  const collectedWorkfilePaths = isRedactedSkillRead
    ? []
    : getSandboxCollectedWorkfilePaths({
        output: toolCall.output,
        toolName: toolCall.tool,
      });
  const sandboxDetails = isRedactedSkillRead
    ? []
    : getSandboxToolResultDetails({
        input: toolCall.input,
        output: toolCall.output,
        toolName: toolCall.tool,
      });
  const sandboxTimeline = isRedactedSkillRead
    ? []
    : getSandboxToolOperationTimeline({
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
  const hasReadFilePreview = Boolean(readFilePreview);
  const effectiveDefaultOpen = resolveAssistantToolCardDefaultOpen({
    defaultOpen,
    hasReadFilePreview,
    statusLabel,
  });
  const [isOpen, setIsOpen] = useState(effectiveDefaultOpen);
  const hasDetails =
    detailParts.length > 0 ||
    Boolean(skillReadFileLabel) ||
    Boolean(readFilePreview) ||
    Boolean(readFileBinaryUnsupported) ||
    Boolean(workfileMutationPreview) ||
    Boolean(outputSummary) ||
    sandboxDetails.length > 0 ||
    sandboxTimeline.length > 0 ||
    collectedWorkfilePaths.length > 0 ||
    (!isRedactedSkillRead && Boolean(toolStep?.detail)) ||
    Boolean(toolError) ||
    Boolean(resolvedConfirmationMessage);
  const hasExpandableContent = hasDetails || Boolean(children);

  useEffect(() => {
    setIsOpen(effectiveDefaultOpen);
  }, [effectiveDefaultOpen]);

  return (
    <div className="group text-muted-foreground transition-colors hover:text-foreground">
      <button
        aria-expanded={hasExpandableContent ? isOpen : undefined}
        className={ASSISTANT_ACTIVITY_ROW_CLASS}
        disabled={!hasExpandableContent}
        onClick={() => setIsOpen((value) => !value)}
        type="button"
      >
        <span className={ASSISTANT_ACTIVITY_ICON_CLASS}>
          <StatusIcon label={statusLabel} toolName={toolCall.tool} />
        </span>
        <span className={ASSISTANT_ACTIVITY_LABEL_CLASS}>
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
        <div className={cn(ASSISTANT_ACTIVITY_DETAIL_CLASS, contentClassName)}>
          {hasDetails && detailParts.length > 0 ? (
            <p className="break-words">{detailParts.join(" · ")}</p>
          ) : null}
          {hasDetails && skillReadFileLabel ? (
            <p className="break-words">Read file: {skillReadFileLabel}</p>
          ) : null}
          {hasDetails && readFilePreview ? (
            <ReadFilePreviewDetails preview={readFilePreview} />
          ) : null}
          {hasDetails && readFileBinaryUnsupported ? (
            <ReadFileBinaryUnsupportedDetails
              unsupported={readFileBinaryUnsupported}
            />
          ) : null}
          {hasDetails && workfileMutationPreview ? (
            <WorkfileMutationPreview
              onWorkfileClick={onWorkfileClick}
              preview={workfileMutationPreview}
            />
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
