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
import type { ArtifactStatusSnapshot } from "./types";
import { formatCompactDuration } from "./duration-format";
import {
  isDeliverableGenerationActive,
  isDeliverableToolName,
  resolveDeliverableElapsedMs,
  resolveDeliverableProgress,
  resolveDeliverableStatus,
  shouldSuppressDeliverableOutputSummary,
} from "./artifact-progress";
import { resolveToolCallArtifactId } from "./artifact-work-state";
import { useArtifactSnapshot } from "./use-artifact-snapshot";
import { DeliverablePipeline } from "./deliverable-pipeline";
import {
  ASSISTANT_ACTIVITY_DETAIL_CLASS,
  ASSISTANT_ACTIVITY_ICON_CLASS,
  ASSISTANT_ACTIVITY_LABEL_CLASS,
  ASSISTANT_ACTIVITY_ROW_CLASS,
} from "./assistant-activity-layout";
import {
  resolveAssistantToolCardDefaultOpen,
  TOOL_STATUS_LABELS,
} from "./assistant-tool-card-state";
import type { ToolStatusKey } from "./assistant-tool-card-state";
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
  isSandboxToolCardToolName,
  SandboxToolCard,
} from "./sandbox-tool-card";
import { DelegateToolCard } from "./delegate-tool-card";
import { isDelegateToolName } from "./delegate-tool-card-state";
import { getToolConfirmationOutput } from "./tool-confirmation-state";
import { isUserQuestionTool } from "./user-question-display";
import { UserQuestionToolCard } from "./user-question-tool-card";
import type {
  ThinkingStepRecord,
  ToolCallRecord,
  ToolConfirmationResolution,
} from "./types";

function getStatusKey(input: {
  artifactSnapshot?: ArtifactStatusSnapshot;
  confirmationResolution?: ToolConfirmationResolution | null;
  toolCall: ToolCallRecord;
}): ToolStatusKey {
  if (input.toolCall.approvalState === "rejected") {
    return "rejected";
  }
  const confirmation = getToolConfirmationOutput(input.toolCall.output);
  if (
    confirmation &&
    !isToolConfirmationResolved({
      confirmation,
      confirmationResolution: input.confirmationResolution,
    })
  ) {
    return "needs-approval";
  }
  if (isDeliverableToolName(input.toolCall.tool)) {
    const generationStatus = resolveDeliverableStatus({
      artifactSnapshot: input.artifactSnapshot,
      toolCallOutput: input.toolCall.output,
      toolCallStatus: input.toolCall.status,
      toolName: input.toolCall.tool,
    });
    if (
      isDeliverableGenerationActive({
        artifactSnapshot: input.artifactSnapshot,
        toolCallOutput: input.toolCall.output,
        toolCallStatus: input.toolCall.status,
        toolName: input.toolCall.tool,
      })
    ) {
      return "generating";
    }
    if (generationStatus === "failed") {
      return "failed";
    }
  }
  if (input.toolCall.status === "running") {
    return "running";
  }
  if (input.toolCall.status === "approval_requested") {
    return "needs-approval";
  }
  if (input.toolCall.status === "error") {
    return "failed";
  }
  return "done";
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

function StatusIcon({
  statusKey,
  toolName,
}: {
  statusKey: ToolStatusKey;
  toolName: string;
}) {
  if (statusKey === "running" || statusKey === "generating") {
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
  return <ToolTypeIcon toolName={toolName} />;
}

function formatToolDuration(latencyMs: number | null | undefined) {
  if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs)) {
    return null;
  }
  if (latencyMs < 1000) {
    return `${Math.max(1, Math.round(latencyMs))}ms`;
  }
  return formatCompactDuration(latencyMs);
}

function getOutputSummary(toolCall: ToolCallRecord) {
  if (isRedactedSkillInstructionRead(toolCall)) {
    return null;
  }
  if (getReadFilePreview(toolCall)) {
    return null;
  }
  if (
    shouldSuppressDeliverableOutputSummary({
      toolCallOutput: toolCall.output,
      toolName: toolCall.tool,
    })
  ) {
    return null;
  }
  const confirmation = getToolConfirmationOutput(toolCall.output);
  if (confirmation) {
    return null;
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
  return <p className="break-words text-muted-foreground/80">{message}</p>;
}

export type AssistantToolCardProps = {
  artifactStatuses?: ReadonlyMap<string, ArtifactStatusSnapshot>;
  children?: ReactNode;
  contentClassName?: string;
  defaultOpen?: boolean;
  onWorkfileClick?: (path: string) => void;
  resolvedConfirmations?: ToolConfirmationResolution[];
  toolCall: ToolCallRecord;
  toolStep?: ThinkingStepRecord;
  workspaceId?: string | null;
};

export function AssistantToolCard(props: AssistantToolCardProps) {
  if (isUserQuestionTool(props.toolCall.tool)) {
    return <UserQuestionToolCard {...props} />;
  }
  if (isDelegateToolName(props.toolCall.tool)) {
    return <DelegateToolCard toolCall={props.toolCall} />;
  }
  if (isSandboxToolCardToolName(props.toolCall.tool)) {
    return (
      <SandboxToolCard
        contentClassName={props.contentClassName}
        defaultOpen={props.defaultOpen}
        onWorkfileClick={props.onWorkfileClick}
        resolvedConfirmations={props.resolvedConfirmations}
        toolCall={props.toolCall}
        toolStep={props.toolStep}
      >
        {props.children}
      </SandboxToolCard>
    );
  }
  return <GenericAssistantToolCard {...props} />;
}

function GenericAssistantToolCard({
  artifactStatuses,
  children,
  contentClassName,
  defaultOpen,
  onWorkfileClick,
  resolvedConfirmations = [],
  toolCall,
  toolStep,
  workspaceId,
}: AssistantToolCardProps) {
  const confirmation = getToolConfirmationOutput(toolCall.output);
  const confirmationResolution = confirmation
    ? resolvedConfirmations.find(
        (item) => item.confirmationId === confirmation.id,
      )
    : null;
  const isDeliverableTool = isDeliverableToolName(toolCall.tool);
  const deliverableArtifactId = isDeliverableTool
    ? resolveToolCallArtifactId(toolCall.output)
    : undefined;
  const parentVideoPresentationSnapshot = deliverableArtifactId
    ? artifactStatuses?.get(deliverableArtifactId)
    : undefined;
  const { snapshot: deliverableSnapshot } = useArtifactSnapshot({
    artifactSnapshot: parentVideoPresentationSnapshot,
    enabled: isDeliverableTool,
    toolCallOutput: toolCall.output,
    workspaceId,
  });
  const effectiveArtifactStatuses = (() => {
    if (!deliverableArtifactId || !deliverableSnapshot) {
      return artifactStatuses;
    }
    const next = new Map(artifactStatuses ?? []);
    next.set(deliverableArtifactId, deliverableSnapshot);
    return next;
  })();
  const statusKey = getStatusKey({
    artifactSnapshot: deliverableSnapshot,
    confirmationResolution,
    toolCall,
  });
  const statusLabel = TOOL_STATUS_LABELS[statusKey];
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
    : getToolCallDetailParts(
        toolCall,
        toolStep,
        confirmationResolution,
        effectiveArtifactStatuses,
      );
  const visibleDetailParts = isDeliverableTool
    ? detailParts.filter(
        (part) => !part.startsWith("status: ") && !part.startsWith("time: "),
      )
    : detailParts;
  const outputSummary = getOutputSummary(toolCall);
  const toolError = toolCall.error;
  const isDeliverableGeneratingNow = isDeliverableTool
    ? isDeliverableGenerationActive({
        artifactSnapshot: deliverableSnapshot,
        toolCallOutput: toolCall.output,
        toolCallStatus: toolCall.status,
        toolName: toolCall.tool,
      })
    : false;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isDeliverableGeneratingNow) {
      return;
    }
    setNowMs(Date.now());
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isDeliverableGeneratingNow]);
  const deliverableElapsedMs = isDeliverableTool
    ? resolveDeliverableElapsedMs({
        artifactSnapshot: deliverableSnapshot,
        nowMs,
        toolCallOutput: toolCall.output,
        toolCallStatus: toolCall.status,
        toolName: toolCall.tool,
      })
    : null;
  // Never show the fire-and-forget tool latency (~200ms) for video presentation.
  const duration = formatToolDuration(
    isDeliverableTool ? deliverableElapsedMs : toolCall.latencyMs,
  );
  const deliverableProgress = isDeliverableTool
    ? resolveDeliverableProgress({
        artifactSnapshot: deliverableSnapshot,
        toolCallOutput: toolCall.output,
        toolCallStatus: toolCall.status,
        toolName: toolCall.tool,
      })
    : null;
  const activeStageLabel = deliverableProgress?.steps.find(
    (step) => step.status === "running",
  )?.label;
  const visibleStatus =
    statusKey === "done"
      ? null
      : statusKey === "generating" && activeStageLabel
        ? activeStageLabel
        : statusLabel;
  const resolvedConfirmationMessage = getResolvedToolConfirmationMessage({
    confirmation,
    confirmationResolution,
  });
  const hasReadFilePreview = Boolean(readFilePreview);
  const effectiveDefaultOpen = resolveAssistantToolCardDefaultOpen({
    defaultOpen,
    hasReadFilePreview,
    statusKey,
  });
  const [isOpen, setIsOpen] = useState(effectiveDefaultOpen);
  const hasDetails =
    visibleDetailParts.length > 0 ||
    Boolean(skillReadFileLabel) ||
    Boolean(readFilePreview) ||
    Boolean(readFileBinaryUnsupported) ||
    Boolean(workfileMutationPreview) ||
    Boolean(outputSummary) ||
    (!isRedactedSkillRead && Boolean(toolStep?.detail)) ||
    Boolean(toolError) ||
    Boolean(resolvedConfirmationMessage) ||
    Boolean(isDeliverableTool && deliverableArtifactId);
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
          <StatusIcon statusKey={statusKey} toolName={toolCall.tool} />
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
          {hasDetails && visibleDetailParts.length > 0 ? (
            <p className="break-words">{visibleDetailParts.join(" · ")}</p>
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
          {hasDetails &&
          toolError &&
          !(isDeliverableTool && deliverableArtifactId) ? (
            // Deliverable failures are shown in the pipeline below (per-step,
            // with context), so don't also repeat the raw error line here.
            <p className="break-words text-destructive">{toolError}</p>
          ) : null}
          {isDeliverableTool && deliverableArtifactId ? (
            <DeliverablePipeline
              artifactSnapshot={deliverableSnapshot}
              toolCallOutput={toolCall.output}
              toolCallStatus={toolCall.status}
              toolName={toolCall.tool}
            />
          ) : null}
          {children}
        </div>
      ) : null}
    </div>
  );
}
