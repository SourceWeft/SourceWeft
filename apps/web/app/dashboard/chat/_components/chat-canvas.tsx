import {
  cloneElement,
  createElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  ArrowUp,
  Copy,
  FileText,
  Globe,
  Loader2,
  Pencil,
  Brain,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  WrenchIcon,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@sourceweft/ui-web/components/ai-elements/conversation";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageBranch,
  MessageBranchContent,
  MessageBranchNext,
  MessageBranchPage,
  MessageBranchPrevious,
  MessageBranchSelector,
  MessageContent,
  MessageResponse,
  MessageToolbar,
} from "@sourceweft/ui-web/components/ai-elements/message";
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@sourceweft/ui-web/components/ai-elements/attachments";
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@sourceweft/ui-web/components/ai-elements/prompt-input";
import {
  Suggestion,
  Suggestions,
} from "@sourceweft/ui-web/components/ai-elements/suggestion";
import { Shimmer } from "@sourceweft/ui-web/components/ai-elements/shimmer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@sourceweft/ui-web/components/ui/dropdown-menu";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
} from "@sourceweft/ui-web/components/ai-elements/chain-of-thought";
import { cn } from "@sourceweft/ui-web/lib/utils";
import type { SourceItem } from "./mock-data";

const starterSuggestions = [
  "Summarize the selected sources",
  "Compare the main claims across these documents",
  "What changed between these reports?",
  "List the strongest supporting evidence",
];

function toAttachmentData(source: SourceItem) {
  return {
    id: source.id,
    mediaType: source.type,
    sourceId: source.id,
    subtitle: source.meta,
    title: source.title,
    type: "source-document" as const,
  };
}

export type MessageVersion = {
  id: string;
  content: string;
  citations?: CitationRecord[];
  availableCitations?: CitationRecord[];
  isError?: boolean;
  isTextPaused?: boolean;
  isTextInterrupted?: boolean;
  sourceIds?: string[];
  sourceAssistantMessageId?: string | null;
  sourceUserMessageId?: string | null;
  toolCalls?: ToolCallRecord[];
  thinkingSteps?: ThinkingStepRecord[];
  modelReasoning?: string;
  modelReasoningSegments?: ModelReasoningSegmentRecord[];
};

export type ThinkingEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type ThinkingMode = "auto" | "off" | "effort";

export type PromptThinkingSettings = {
  mode: ThinkingMode;
  effort: ThinkingEffort;
};

export type PromptThinkingCapabilities = {
  supportsThinking: boolean;
  supportedParameters?: string[];
  supportedEfforts?: ThinkingEffort[];
  reasoning?: boolean;
  reasoningEffort?: boolean;
  includeReasoning?: boolean;
  supportSources?: string[];
};

export type ChatSkillItem = {
  id: string;
  catalogId: string;
  slug: string;
  name: string;
  displayName: string;
  description: string;
  sourceType: "builtin" | "workspace_custom" | "team_custom";
  version: string;
  hasReadme: boolean;
};

const thinkingEffortOptions: Array<{ value: ThinkingEffort; label: string }> = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Standard" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
];

export const DEFAULT_PROMPT_THINKING_SETTINGS: PromptThinkingSettings = {
  mode: "auto",
  effort: "medium",
};

export type CitationRecord = {
  citation: string;
  sourceId: string;
  sourceTitle?: string;
  documentId: string;
  chunkId: string;
  chunkNo?: number;
  score: number;
  excerpt: string;
};

export type ToolCallRecord = {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  output: unknown;
  latencyMs: number | null;
  status: "running" | "completed" | "error";
  error: string | null;
  sequence?: number;
};

export type ThinkingStepRecord = {
  id: string;
  kind?: "log" | "state" | "verification" | "reasoning_summary";
  title: string;
  status: "pending" | "in_progress" | "completed";
  items: string[];
  sequence?: number;
  description?: string | null;
  detail?: string | null;
  metadata?: Record<string, unknown>;
};

export type ModelReasoningSegmentRecord = {
  id: string;
  text: string;
  sequence?: number;
  durationMs?: number;
};

export type VersionedMessageGroup = {
  groupId: string;
  turnId?: string;
  role: "user" | "assistant";
  versions: MessageVersion[];
  latestVersionId: string;
};

function getMessageText(version: MessageVersion): string {
  return version.content;
}

const CITATION_PATTERN = /[[【]\u200B?citation:\s*([\w:-]+(?:\s*,\s*[\w:-]+)*)\s*\u200B?[\]】]/g;

function splitCitationIds(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function resolveCitationFromId(input: {
  citationByChunkId: Map<string, CitationRecord>;
  citationByKey: Map<string, CitationRecord>;
  id: string;
}) {
  return input.citationByKey.get(input.id) ?? input.citationByChunkId.get(input.id);
}

function getCitationLabel(citation: CitationRecord | undefined, fallback: string) {
  return citation?.sourceTitle?.trim() || (citation ? "Source" : fallback || "Source");
}

function CitationBadge({
  citation,
  label,
  onCitationClick,
}: {
  citation?: CitationRecord;
  label: string;
  onCitationClick?: (citation: CitationRecord) => void;
}) {
  return (
    <button
      className={cn(
        "mx-0.5 inline-flex max-w-[14rem] cursor-pointer items-center justify-center rounded-full bg-primary/10 px-1.5 py-0.5 align-baseline text-[11px] font-medium leading-none text-primary transition-colors hover:bg-primary/15",
        !citation && "cursor-default bg-muted text-muted-foreground hover:bg-muted",
      )}
      disabled={!citation}
      onClick={() => {
        if (citation) {
          onCitationClick?.(citation);
        }
      }}
      title={citation?.excerpt ?? `Citation ${label}`}
      type="button"
    >
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

function makeCitationNode(input: {
  citationByChunkId: Map<string, CitationRecord>;
  citationByKey: Map<string, CitationRecord>;
  id: string;
  instanceIndex: number;
  onCitationClick?: (citation: CitationRecord) => void;
}) {
  const citation = resolveCitationFromId(input);
  const label = getCitationLabel(citation, input.id);

  return (
    <CitationBadge
      citation={citation}
      key={`citation-${input.id}-${input.instanceIndex}`}
      label={label}
      onCitationClick={input.onCitationClick}
    />
  );
}

function parseCitationText(input: {
  citationByChunkId: Map<string, CitationRecord>;
  citationByKey: Map<string, CitationRecord>;
  onCitationClick?: (citation: CitationRecord) => void;
  text: string;
}) {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let instanceIndex = 0;

  CITATION_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CITATION_PATTERN.exec(input.text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(input.text.slice(lastIndex, match.index));
    }

    for (const id of splitCitationIds(match[1] ?? "")) {
      parts.push(
        makeCitationNode({
          citationByChunkId: input.citationByChunkId,
          citationByKey: input.citationByKey,
          id,
          instanceIndex: instanceIndex++,
          onCitationClick: input.onCitationClick,
        }),
      );
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < input.text.length) {
    parts.push(input.text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : [input.text];
}

function processCitationChildren(input: {
  children: ReactNode;
  citationByChunkId: Map<string, CitationRecord>;
  citationByKey: Map<string, CitationRecord>;
  onCitationClick?: (citation: CitationRecord) => void;
}): ReactNode {
  if (typeof input.children === "string") {
    return parseCitationText({
      citationByChunkId: input.citationByChunkId,
      citationByKey: input.citationByKey,
      onCitationClick: input.onCitationClick,
      text: input.children,
    });
  }

  if (Array.isArray(input.children)) {
    return input.children.map((child, index) => (
      <span key={index}>
        {processCitationChildren({
          ...input,
          children: child,
        })}
      </span>
    ));
  }

  if (isValidElement(input.children)) {
    const child = input.children as ReactElement<{ children?: ReactNode }>;
    if (child.type === "code" || child.type === "pre" || child.type === "a") {
      return child;
    }
    return cloneElement(child, {
      children: processCitationChildren({
        ...input,
        children: child.props.children,
      }),
    });
  }

  return input.children;
}

function CitationAwareMessageResponse({
  availableCitations,
  citations,
  children,
  onCitationClick,
  showLoading = false,
}: {
  availableCitations?: CitationRecord[];
  citations: CitationRecord[] | undefined;
  children: string;
  onCitationClick?: (citation: CitationRecord) => void;
  showLoading?: boolean;
}) {
  const citationByKey = new Map(
    (citations ?? []).map((citation) => [citation.citation, citation]),
  );
  const citationByChunkId = new Map(
    (citations ?? []).map((citation) => [citation.chunkId, citation]),
  );
  const hasInlineCitationMarkers = (() => {
    CITATION_PATTERN.lastIndex = 0;
    return CITATION_PATTERN.test(children);
  })();
  const possibleEvidence = !hasInlineCitationMarkers &&
    (citations?.length ?? 0) === 0
    ? (availableCitations ?? [])
    : [];
  const textComponent = ({ children: nodeChildren }: { children?: ReactNode }) => (
    <>
      {processCitationChildren({
        children: nodeChildren,
        citationByChunkId,
        citationByKey,
        onCitationClick,
      })}
    </>
  );

  const paragraphComponent = ({ children: nodeChildren }: { children?: ReactNode }) =>
    createElement("p", null, textComponent({ children: nodeChildren }));
  const listItemComponent = ({ children: nodeChildren }: { children?: ReactNode }) =>
    createElement("li", null, textComponent({ children: nodeChildren }));
  const strongComponent = ({ children: nodeChildren }: { children?: ReactNode }) =>
    createElement("strong", null, textComponent({ children: nodeChildren }));
  const emphasisComponent = ({ children: nodeChildren }: { children?: ReactNode }) =>
    createElement("em", null, textComponent({ children: nodeChildren }));
  const blockquoteComponent = ({ children: nodeChildren }: { children?: ReactNode }) =>
    createElement("blockquote", null, textComponent({ children: nodeChildren }));
  const h1Component = ({ children: nodeChildren }: { children?: ReactNode }) =>
    createElement("h1", null, textComponent({ children: nodeChildren }));
  const h2Component = ({ children: nodeChildren }: { children?: ReactNode }) =>
    createElement("h2", null, textComponent({ children: nodeChildren }));
  const h3Component = ({ children: nodeChildren }: { children?: ReactNode }) =>
    createElement("h3", null, textComponent({ children: nodeChildren }));
  const h4Component = ({ children: nodeChildren }: { children?: ReactNode }) =>
    createElement("h4", null, textComponent({ children: nodeChildren }));
  const h5Component = ({ children: nodeChildren }: { children?: ReactNode }) =>
    createElement("h5", null, textComponent({ children: nodeChildren }));
  const h6Component = ({ children: nodeChildren }: { children?: ReactNode }) =>
    createElement("h6", null, textComponent({ children: nodeChildren }));
  const tableCellComponent = ({ children: nodeChildren }: { children?: ReactNode }) =>
    createElement(
      "td",
      { className: "border border-border px-3 py-2 align-top" },
      textComponent({ children: nodeChildren }),
    );
  const tableHeaderComponent = ({ children: nodeChildren }: { children?: ReactNode }) =>
    createElement(
      "th",
      { className: "border border-border bg-muted/40 px-3 py-2 text-left align-top font-semibold text-foreground" },
      textComponent({ children: nodeChildren }),
    );

  return (
    <div>
      <MessageResponse
        components={{
          a: ({ children: nodeChildren, ...props }) => <a {...props}>{nodeChildren}</a>,
          blockquote: blockquoteComponent as never,
          em: emphasisComponent as never,
          h1: h1Component as never,
          h2: h2Component as never,
          h3: h3Component as never,
          h4: h4Component as never,
          h5: h5Component as never,
          h6: h6Component as never,
          li: listItemComponent as never,
          p: paragraphComponent as never,
          strong: strongComponent as never,
          td: tableCellComponent as never,
          th: tableHeaderComponent as never,
        }}
      >
        {children}
      </MessageResponse>
      {showLoading ? (
        <span className="mt-1 inline-flex items-center gap-1 text-muted-foreground" aria-label="Thinking">
          <span className="size-1 animate-pulse rounded-full bg-current" />
          <span className="size-1 animate-pulse rounded-full bg-current [animation-delay:120ms]" />
          <span className="size-1 animate-pulse rounded-full bg-current [animation-delay:240ms]" />
        </span>
      ) : null}
      <PossibleEvidenceStrip
        evidence={possibleEvidence}
        onCitationClick={onCitationClick}
      />
    </div>
  );
}

function PossibleEvidenceStrip({
  evidence,
  onCitationClick,
}: {
  evidence: CitationRecord[];
  onCitationClick?: (citation: CitationRecord) => void;
}) {
  if (evidence.length === 0) {
    return null;
  }

  const visibleEvidence = evidence.slice(0, 4);
  const hiddenCount = evidence.length - visibleEvidence.length;

  return (
    <div className="mt-3 rounded-2xl border border-dashed bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
      <div className="mb-2 flex items-center gap-1.5 font-medium text-foreground/80">
        <FileText className="size-3.5" />
        <span>Possible evidence</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {visibleEvidence.map((citation, index) => (
          <button
            className="inline-flex max-w-[240px] items-center gap-1.5 rounded-full border border-input bg-background/80 px-2 py-1 text-left text-xs text-foreground shadow-xs transition-colors hover:border-primary/35 hover:bg-primary/5"
            key={`${citation.citation}-${citation.chunkId}`}
            onClick={() => onCitationClick?.(citation)}
            title={citation.excerpt}
            type="button"
          >
            <span className="text-[10px] font-semibold text-primary">
              {index + 1}
            </span>
            <span className="truncate">
              {citation.sourceTitle?.trim() || "Untitled source"}
            </span>
          </button>
        ))}
        {hiddenCount > 0 ? (
          <span className="inline-flex items-center rounded-full border border-input bg-background/80 px-2 py-1 text-xs shadow-xs">
            +{hiddenCount} more
          </span>
        ) : null}
      </div>
      <p className="mt-2 leading-5">
        The answer did not include inline citation markers; these sources were
        read or retrieved during generation.
      </p>
    </div>
  );
}

function ReferencedFiles({ sources }: { sources: SourceItem[] }) {
  if (sources.length === 0) {
    return null;
  }

  const showCountOnly = sources.length > 2;
  const visible = showCountOnly ? [] : sources;

  return (
    <div className="ml-auto flex max-w-[85%] flex-wrap justify-end gap-1.5 pb-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center px-1 font-medium text-foreground/70">
        Referenced files
      </span>
      {showCountOnly ? (
        <span className="rounded-full border border-input bg-background/80 px-2 py-0.5 shadow-xs">
          {sources.length} files
        </span>
      ) : (
        visible.map((source) => (
          <span
            className="inline-flex max-w-[220px] items-center gap-1 rounded-full border border-input bg-background/80 px-2 py-0.5 shadow-xs"
            key={source.id}
            title={source.title}
          >
            <FileText className="size-3" />
            <span className="truncate">{source.title}</span>
          </span>
        ))
      )}
    </div>
  );
}

function compactText(value: string, maxLength = 160) {
  const compacted = value.replace(/\s+/g, " ").trim();
  return compacted.length > maxLength ? `${compacted.slice(0, maxLength - 1)}…` : compacted;
}

function getToolOutputContent(output: unknown) {
  if (output === null || output === undefined) {
    return null;
  }

  if (typeof output === "string") {
    return output;
  }

  if (typeof output === "object") {
    const record = output as Record<string, unknown>;
    if (typeof record.content === "string") {
      return record.content;
    }
    return JSON.stringify(output);
  }

  return String(output);
}

function getRecordValue(record: Record<string, unknown> | undefined, key: string) {
  return record ? record[key] : undefined;
}

function getToolQuery(toolCall: ToolCallRecord, toolStep?: ThinkingStepRecord) {
  const inputQuery = getRecordValue(toolCall.input, "query");
  if (typeof inputQuery === "string" && inputQuery.trim().length > 0) {
    return inputQuery.trim();
  }

  const output = toolCall.output && typeof toolCall.output === "object"
    ? (toolCall.output as Record<string, unknown>)
    : undefined;
  const outputQuery = getRecordValue(output, "query");
  if (typeof outputQuery === "string" && outputQuery.trim().length > 0) {
    return outputQuery.trim();
  }

  const metadataQuery = getRecordValue(toolStep?.metadata, "query");
  return typeof metadataQuery === "string" && metadataQuery.trim().length > 0
    ? metadataQuery.trim()
    : null;
}

function getToolHitCount(toolCall: ToolCallRecord, toolStep?: ThinkingStepRecord) {
  const output = toolCall.output && typeof toolCall.output === "object"
    ? (toolCall.output as Record<string, unknown>)
    : undefined;
  const outputHitCount = getRecordValue(output, "hitCount");
  if (typeof outputHitCount === "number" && Number.isFinite(outputHitCount)) {
    return outputHitCount;
  }

  const metadataHitCount = getRecordValue(toolStep?.metadata, "hitCount");
  return typeof metadataHitCount === "number" && Number.isFinite(metadataHitCount)
    ? metadataHitCount
    : null;
}

function summarizeToolOutput(output: unknown) {
  const content = getToolOutputContent(output);
  return content ? compactText(content) : null;
}

function formatToolName(toolName: string) {
  return toolName.replace(/[_-]+/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

function getToolDisplayLabel(toolCall: ToolCallRecord) {
  if (toolCall.tool === "search_sources") {
    const query = getToolQuery(toolCall);
    return query ? `Search sources: ${compactText(query, 72)}` : "Search sources";
  }

  const inputPreview = Object.entries(toolCall.input)
    .map(([key, value]) =>
      typeof value === "string" && value.trim().length > 0
        ? `${key}: ${compactText(value, 48)}`
        : null,
    )
    .find((value): value is string => value !== null);

  const toolName = formatToolName(toolCall.tool);
  const prefix =
    toolCall.status === "running"
      ? "Using"
      : toolCall.status === "error"
        ? "Failed"
        : "Used";

  return inputPreview ? `${prefix} ${toolName} (${inputPreview})` : `${prefix} ${toolName}`;
}

function formatThinkingMetadataValue(key: string, value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "boolean") {
    if (!value) {
      return null;
    }
    return value ? "yes" : "no";
  }

  if (typeof value === "number") {
    if (key === "removedCitationCount" && value <= 0) {
      return null;
    }
    return key === "latencyMs" ? `${Math.round(value)}ms` : String(value);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return compactText(value, 64);
  }

  return null;
}

function getThinkingMetadataParts(metadata: Record<string, unknown> | undefined) {
  if (!metadata) {
    return [] as string[];
  }

  const labels: Record<string, string> = {
    availableCitationCount: "available citations",
    chunkCount: "chunks",
    hitCount: "hits",
    latencyMs: "time",
    matchCount: "matches",
    removedCitationCount: "removed citations",
    resultCount: "results",
    sourceCount: "sources",
    truncated: "truncated",
    usedCitationCount: "used citations",
  };

  return Object.keys(labels)
    .map((key) => {
      const formatted = formatThinkingMetadataValue(key, metadata[key]);
      return formatted ? `${labels[key]}: ${formatted}` : null;
    })
    .filter((item): item is string => item !== null);
}

function getToolStepMetadataParts(metadata: Record<string, unknown> | undefined) {
  if (!metadata) {
    return [] as string[];
  }

  const rest = { ...metadata };
  delete rest.hitCount;
  delete rest.latencyMs;
  return getThinkingMetadataParts(rest);
}

function getToolCallDetailParts(toolCall: ToolCallRecord, toolStep?: ThinkingStepRecord) {
  const hitCount = getToolHitCount(toolCall, toolStep);
  const latencyMs = toolCall.latencyMs ??
    (typeof toolStep?.metadata?.latencyMs === "number" ? toolStep.metadata.latencyMs : null);
  return [
    `status: ${toolCall.status}`,
    hitCount !== null ? `hits: ${hitCount}` : null,
    typeof latencyMs === "number" ? `time: ${Math.round(latencyMs)}ms` : null,
  ].filter((part): part is string => part !== null);
}

function ToolCallDetails({
  toolCall,
  toolStep,
}: {
  toolCall: ToolCallRecord;
  toolStep?: ThinkingStepRecord;
}) {
  const query = getToolQuery(toolCall, toolStep);
  const shouldShowQuery = Boolean(query && toolCall.tool !== "search_sources");
  const outputSummary = summarizeToolOutput(toolCall.output);
  const shouldShowOutputSummary = Boolean(
      outputSummary &&
      toolCall.tool !== "search_sources" &&
      outputSummary !== "{}",
  );

  return (
    <div className="space-y-2 text-muted-foreground text-xs leading-5">
      {shouldShowQuery ? (
        <p>
          <span className="font-medium text-foreground/80">Query:</span> {query}
        </p>
      ) : null}
      {toolStep?.detail ? <p>{toolStep.detail}</p> : null}
      {shouldShowOutputSummary ? <p>{outputSummary}</p> : null}
      {toolCall.error ? <p className="text-destructive">{toolCall.error}</p> : null}
    </div>
  );
}

function formatThoughtDuration(durationMs: number | undefined) {
  if (durationMs === undefined) {
    return "Thought for a few seconds";
  }

  const duration = Math.max(1, Math.ceil(durationMs / 1000));
  return `Thought for ${duration} ${duration === 1 ? "second" : "seconds"}`;
}

function ReasoningTrace({
  isStreaming,
  modelReasoning,
  modelReasoningSegments,
  steps,
  toolCalls,
}: {
  isStreaming: boolean;
  modelReasoning?: string;
  modelReasoningSegments?: ModelReasoningSegmentRecord[];
  steps: ThinkingStepRecord[] | undefined;
  toolCalls: ToolCallRecord[] | undefined;
}) {
  const safeReasoningSegments = (modelReasoningSegments ?? [])
    .map((segment, index) => ({
      ...segment,
      id: segment.id || `model-reasoning-${index + 1}`,
      text: segment.text.trim(),
      sequence: segment.sequence ?? index,
    }))
    .filter((segment) => segment.text.length > 0);
  const modelReasoningText = modelReasoning?.trim();
  const fallbackReasoningSegments =
    safeReasoningSegments.length === 0 && modelReasoningText
      ? [
          {
            id: "model-reasoning",
            text: modelReasoningText,
            sequence: -1,
            durationMs: undefined,
          },
        ]
      : [];
  const displayReasoningSegments = safeReasoningSegments.length > 0
    ? safeReasoningSegments
    : fallbackReasoningSegments;
  const hasModelReasoning = displayReasoningSegments.length > 0;
  const safeSteps = steps ?? [];
  const safeToolCalls = (toolCalls ?? []).filter((toolCall, index, calls) => {
    return calls.findIndex((call) => call.id === toolCall.id) === index;
  });
  const stepByToolCallId = new Map(
    safeSteps
      .map((step) => {
        const toolCallId = step.metadata?.toolCallId;
        return typeof toolCallId === "string" ? ([toolCallId, step] as const) : null;
      })
      .filter((entry): entry is readonly [string, ThinkingStepRecord] => entry !== null),
  );
  const toolCallIds = new Set(safeToolCalls.map((toolCall) => toolCall.id));
  const displaySteps = safeSteps.filter((step) => {
    const toolCallId = step.metadata?.toolCallId;
    return !(typeof toolCallId === "string" && toolCallIds.has(toolCallId));
  });
  const activeStep = safeSteps.find((step) => step.status === "in_progress");
  const hasRunningToolCall = safeToolCalls.some((toolCall) => toolCall.status === "running");
  const isThinking = isStreaming || Boolean(activeStep) || hasRunningToolCall;
  const hasTraceItems = safeSteps.length + safeToolCalls.length + (hasModelReasoning ? 1 : 0) > 0;
  const allComplete =
    hasTraceItems &&
    safeSteps.every((step) => step.status === "completed") &&
    !hasRunningToolCall &&
    !isStreaming;
  const [isOpen, setIsOpen] = useState(!allComplete);
  const [duration, setDuration] = useState<number | undefined>(undefined);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const startTimeRef = useRef<number | null>(null);

  const timelineItems = [
    ...displayReasoningSegments.map((segment) => ({
      kind: "model-reasoning" as const,
      key: `model-reasoning:${segment.id}`,
      sequence: segment.sequence ?? -1,
      text: segment.text,
    })),
    ...displaySteps.map((step, index) => ({
      kind: "step" as const,
      key: `step:${step.id}`,
      sequence: step.sequence ?? index,
      step,
    })),
    ...safeToolCalls.map((toolCall, index) => ({
      kind: "tool" as const,
      key: `tool:${toolCall.id}`,
      sequence:
        stepByToolCallId.get(toolCall.id)?.sequence ??
        toolCall.sequence ??
        safeSteps.length + index,
      toolCall,
      toolStep: stepByToolCallId.get(toolCall.id),
    })),
  ].sort((left, right) => left.sequence - right.sequence);
  const timelineSignature = timelineItems
    .map((item) => {
      if (item.kind === "model-reasoning") {
        return `${item.key}:${item.text.length}`;
      }
      if (item.kind === "step") {
        return `${item.key}:${item.step.status}:${item.step.title}:${item.step.items.length}`;
      }
      return `${item.key}:${item.toolCall.status}:${item.toolCall.latencyMs ?? ""}`;
    })
    .join("|");
  const reasoningDurationMs = displayReasoningSegments.reduce<number | undefined>(
    (longest, segment) => {
      if (typeof segment.durationMs !== "number") {
        return longest;
      }

      return Math.max(longest ?? 0, segment.durationMs);
    },
    undefined,
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const element = contentRef.current;
    if (!element) {
      return;
    }

    element.scrollTop = element.scrollHeight;
  }, [isOpen, timelineSignature]);

  useEffect(() => {
    if (isStreaming) {
      if (startTimeRef.current === null) {
        startTimeRef.current = Date.now();
      }
      return;
    }

    if (startTimeRef.current !== null) {
      setDuration(Date.now() - startTimeRef.current);
      startTimeRef.current = null;
    }
  }, [isStreaming]);

  if (!hasTraceItems && !isStreaming) {
    return null;
  }

  const title = activeStep
    ? `Thinking · ${activeStep.title}`
    : hasModelReasoning && !isStreaming
      ? formatThoughtDuration(reasoningDurationMs ?? duration)
      : "Thinking...";

  return (
    <ChainOfThought
      className="space-y-0 py-1"
      onOpenChange={setIsOpen}
      open={isOpen}
    >
      <ChainOfThoughtHeader
        className="py-0"
        icon={isThinking ? <Loader2 className="size-4 animate-spin" /> : undefined}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">
            {isThinking ? (
              <Shimmer duration={1}>{title}</Shimmer>
            ) : (
              title
            )}
          </span>
          {isThinking ? (
            <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 font-medium text-[11px] text-primary">
              Running
            </span>
          ) : null}
        </span>
      </ChainOfThoughtHeader>
      {isOpen && timelineItems.length > 0 ? (
        <ChainOfThoughtContent className="max-h-64 overflow-y-auto pr-1" ref={contentRef}>
          {timelineItems.map((item) => {
            if (item.kind === "model-reasoning") {
              return (
                <ChainOfThoughtStep
                  key={item.key}
                  label="Model reasoning"
                  status={isStreaming ? "active" : "complete"}
                >
                  <div className="whitespace-pre-wrap break-words text-muted-foreground text-xs leading-5">
                    {item.text}
                  </div>
                </ChainOfThoughtStep>
              );
            }

            if (item.kind === "step") {
              const { step } = item;
              const metadataParts = getThinkingMetadataParts(step.metadata);
              const stepDescription = [
                step.description ?? null,
                metadataParts.length > 0 ? metadataParts.join(" · ") : null,
              ]
                .filter((part): part is string => Boolean(part))
                .join(" · ") || undefined;
              const stepLabel = (
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="truncate">{step.title}</span>
                  {stepDescription ? (
                    <span className="min-w-0 text-muted-foreground text-xs leading-5">
                      {stepDescription}
                    </span>
                  ) : null}
                  {step.status === "in_progress" ? (
                    <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 font-medium text-[11px] text-primary">
                      Running
                    </span>
                  ) : null}
                </span>
              );
              return (
                <ChainOfThoughtStep
                  key={item.key}
                  label={stepLabel}
                  status={
                    step.status === "in_progress"
                      ? "active"
                      : step.status === "pending"
                        ? "pending"
                        : "complete"
                  }
                >
                  {step.detail ? (
                    <p className="text-muted-foreground text-xs leading-5">
                      {step.detail}
                    </p>
                  ) : null}
                  {step.items.length > 0 ? (
                    <ChainOfThoughtSearchResults>
                      {step.items.map((result) => (
                        <ChainOfThoughtSearchResult key={`${step.id}:${result}`} title={result}>
                          <span className="max-w-[220px] truncate">{result}</span>
                        </ChainOfThoughtSearchResult>
                      ))}
                    </ChainOfThoughtSearchResults>
                  ) : null}
                </ChainOfThoughtStep>
              );
            }

            const { toolCall, toolStep } = item;
            const metadataParts = getToolStepMetadataParts(toolStep?.metadata);
            const detailParts = getToolCallDetailParts(toolCall, toolStep);
            const summary = [
              toolStep?.description ?? null,
              detailParts.length > 0 ? detailParts.join(" · ") : null,
              metadataParts.length > 0 ? metadataParts.join(" · ") : null,
            ]
              .filter((part): part is string => Boolean(part))
              .join(" · ") || undefined;
            return (
              <ChainOfThoughtStep
                description={summary}
                icon={WrenchIcon}
                key={item.key}
                label={getToolDisplayLabel(toolCall)}
                status={
                  toolCall.status === "running"
                    ? "active"
                    : toolCall.status === "error"
                      ? "pending"
                      : "complete"
                }
              >
                <ToolCallDetails toolCall={toolCall} toolStep={toolStep} />
              </ChainOfThoughtStep>
            );
          })}
        </ChainOfThoughtContent>
      ) : null}
    </ChainOfThought>
  );
}

function Composer({
  isEditing = false,
  placeholder,
  onSubmit,
  onCancelEditing,
  className,
  initialInput = "",
  inputKey,
  selectedSources = [],
  availableSkills = [],
  selectedSkillIds = [],
  onRemoveSource,
  onSkillSelectionChange,
  disabled,
  searchEnabled = false,
  onSearchEnabledChange,
  thinkingCapabilities,
  thinkingSettings = DEFAULT_PROMPT_THINKING_SETTINGS,
  onThinkingSettingsChange,
}: {
  isEditing?: boolean;
  placeholder?: string;
  onSubmit?: (message: PromptInputMessage) => void;
  onCancelEditing?: () => void;
  className?: string;
  initialInput?: string;
  inputKey?: string | number;
  selectedSources?: SourceItem[];
  availableSkills?: ChatSkillItem[];
  selectedSkillIds?: string[];
  onRemoveSource?: (id: string) => void;
  onSkillSelectionChange?: (skillIds: string[]) => void;
  disabled?: boolean;
  searchEnabled?: boolean;
  onSearchEnabledChange?: (enabled: boolean) => void;
  thinkingCapabilities?: PromptThinkingCapabilities;
  thinkingSettings?: PromptThinkingSettings;
  onThinkingSettingsChange?: (settings: PromptThinkingSettings) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const showSourceCountOnly = selectedSources.length > 2;
  const visible = showSourceCountOnly ? [] : selectedSources;
  const hasSelectedSources = selectedSources.length > 0;
  const selectedSkillIdSet = new Set(selectedSkillIds);
  const selectedSkills = availableSkills.filter((skill) => selectedSkillIdSet.has(skill.id));
  const selectedSkillNames = selectedSkills.map((skill) => skill.displayName).join(", ");
  const supportsThinking = thinkingCapabilities?.supportsThinking === true;
  const activeThinkingSettings = supportsThinking
    ? thinkingSettings
    : DEFAULT_PROMPT_THINKING_SETTINGS;
  const thinkingEnabled = activeThinkingSettings.mode !== "off";
  const supportedThinkingEfforts = thinkingEffortOptions.filter((option) =>
    (thinkingCapabilities?.supportedEfforts ?? []).includes(option.value)
  );
  const selectedThinkingValue = activeThinkingSettings.mode === "off"
    ? "off"
    : activeThinkingSettings.mode === "effort"
      ? activeThinkingSettings.effort
      : "auto";

  function updateThinkingSettings(next: PromptThinkingSettings) {
    if (!supportsThinking) {
      return;
    }
    onThinkingSettingsChange?.(next);
  }

  function toggleThinking() {
    if (!activeThinkingSettings) {
      return;
    }

    updateThinkingSettings({
      ...activeThinkingSettings,
      mode: activeThinkingSettings.mode === "off" ? "auto" : "off",
    });
  }

  useEffect(() => {
    if (!isEditing || disabled) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const textarea = rootRef.current?.querySelector(
        'textarea[name="message"]',
      ) as HTMLTextAreaElement | null;
      if (!textarea) {
        return;
      }

      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [disabled, isEditing, inputKey]);

  return (
    <div className={className} ref={rootRef}>
      <PromptInputProvider initialInput={initialInput} key={inputKey}>
        <PromptInput
          onSubmit={(message) => {
            if (disabled) {
              return;
            }
            (onSubmit ?? (() => undefined))(message);
          }}
        >
          {hasSelectedSources ? (
            <PromptInputHeader>
              <Attachments className="gap-2.5 pt-0.5" variant="inline">
                {showSourceCountOnly ? (
                  <Attachment
                    className="rounded-2xl bg-muted/40 px-3 py-2 text-[13px] text-muted-foreground"
                    data={{
                      id: "source-count",
                      mediaType: "text/plain",
                      sourceId: "source-count",
                      title: `${selectedSources.length} selected files`,
                      type: "source-document",
                    }}
                  >
                    {selectedSources.length} selected files
                  </Attachment>
                ) : (
                  visible.map((source) => (
                    <Attachment
                      className="rounded-2xl bg-muted/55 px-3.5 py-2 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.45)]"
                      data={toAttachmentData(source)}
                      key={source.id}
                      onRemove={() => onRemoveSource?.(source.id)}
                    >
                      <AttachmentPreview
                        className="text-foreground/75"
                        fallbackIcon={<FileText className="size-4" />}
                      />
                      <AttachmentInfo className="max-w-[220px] text-[13px] font-medium" />
                      <AttachmentRemove
                        className="text-foreground/55 hover:bg-background/60"
                        label={`Remove ${source.title}`}
                      />
                    </Attachment>
                  ))
                )}
              </Attachments>
            </PromptInputHeader>
          ) : null}
          <PromptInputBody>
              <PromptInputTextarea
                autoFocus={isEditing && !disabled}
                onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                  if (isEditing && event.key === "Escape") {
                    event.preventDefault();
                    onCancelEditing?.();
                    return;
                  }

                  if (
                    disabled &&
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                  }
                }}
                placeholder={
                  placeholder ||
                  "Message your documents, links, or connected tools..."
                }
              />
          </PromptInputBody>
          <PromptInputFooter className="border-t-0">
            <PromptInputTools className="w-full flex-wrap gap-3">
              <div className="flex min-w-0 items-center gap-1.5">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <PromptInputButton
                      className="size-8 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                      size="icon-sm"
                      tooltip="Options"
                      type="button"
                      variant="ghost"
                    >
                      <SlidersHorizontal className="size-3.5" />
                      <span className="sr-only">Options</span>
                    </PromptInputButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-44 p-1">
                    <DropdownMenuLabel className="px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground/80">
                      Options
                    </DropdownMenuLabel>
                    {supportsThinking && supportedThinkingEfforts.length > 0 ? (
                      <>
                        <DropdownMenuSeparator className="my-1" />
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger className="h-8 rounded-lg px-2 text-xs">
                            <Brain className="size-3.5 text-muted-foreground" />
                            Thinking
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent className="w-36 p-1">
                            <DropdownMenuRadioGroup
                              onValueChange={(value) => {
                                if (value === "off") {
                                  updateThinkingSettings({
                                    ...(activeThinkingSettings ?? DEFAULT_PROMPT_THINKING_SETTINGS),
                                    mode: "off",
                                  });
                                  return;
                                }

                                if (value === "auto") {
                                  updateThinkingSettings({
                                    ...(activeThinkingSettings ?? DEFAULT_PROMPT_THINKING_SETTINGS),
                                    mode: "auto",
                                  });
                                  return;
                                }

                                updateThinkingSettings({
                                  mode: "effort",
                                  effort: value as ThinkingEffort,
                                });
                              }}
                              value={selectedThinkingValue}
                            >
                              <DropdownMenuRadioItem
                                className="h-7 rounded-lg py-1.5 pr-7 pl-2 text-xs"
                                value="off"
                              >
                                Off
                              </DropdownMenuRadioItem>
                              <DropdownMenuRadioItem
                                className="h-7 rounded-lg py-1.5 pr-7 pl-2 text-xs"
                                value="auto"
                              >
                                Auto
                              </DropdownMenuRadioItem>
                              {supportedThinkingEfforts.map((option) => (
                                <DropdownMenuRadioItem
                                  className="h-7 rounded-lg py-1.5 pr-7 pl-2 text-xs"
                                  key={option.value}
                                  value={option.value}
                                >
                                  {option.label}
                                </DropdownMenuRadioItem>
                              ))}
                            </DropdownMenuRadioGroup>
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      </>
                    ) : supportsThinking ? (
                      <DropdownMenuItem className="h-8 rounded-lg px-2 text-xs" disabled>
                        Thinking effort unavailable
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem className="h-8 rounded-lg px-2 text-xs" disabled>
                        No options available
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>

                {selectedSkillIds.length > 0 ? (
                  <PromptInputButton
                    aria-pressed
                    className="rounded-xl bg-foreground text-background shadow-sm hover:bg-foreground/90 hover:text-background"
                    size="icon-sm"
                    tooltip={selectedSkillNames || "Selected skills"}
                    type="button"
                    variant="secondary"
                  >
                    <Sparkles className="size-4" />
                    <span className="sr-only">Selected skills</span>
                  </PromptInputButton>
                ) : null}

                <PromptInputButton
                  aria-pressed={searchEnabled}
                  className={
                    searchEnabled
                      ? "rounded-xl bg-foreground text-background shadow-sm hover:bg-foreground/90 hover:text-background"
                      : "rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground"
                  }
                  onClick={() => onSearchEnabledChange?.(!searchEnabled)}
                  size="icon-sm"
                  tooltip={{ content: "Search sources", shortcut: "S" }}
                  type="button"
                  variant={searchEnabled ? "secondary" : "ghost"}
                >
                  <Globe className="size-4" />
                  <span className="sr-only">Search</span>
                </PromptInputButton>

                {supportsThinking ? (
                  <button
                    aria-label={thinkingEnabled ? "Disable Thinking" : "Enable Thinking"}
                    aria-pressed={thinkingEnabled}
                    className={cn(
                      "ml-1 inline-flex h-8 items-center justify-center overflow-hidden rounded-full text-xs font-medium select-none transition-all duration-200 ease-out",
                      thinkingEnabled
                        ? "gap-1.5 bg-foreground px-2.5 text-background shadow-sm hover:bg-foreground/90"
                        : "w-8 border border-transparent bg-transparent px-0 text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                    onClick={toggleThinking}
                    title={thinkingEnabled ? "Disable Thinking" : "Enable Thinking"}
                    type="button"
                  >
                    <Brain
                      className={cn(
                        "size-4 shrink-0 transition-transform duration-300 ease-out",
                        thinkingEnabled ? "rotate-180 scale-110" : "rotate-0 scale-100",
                      )}
                    />
                    <span
                      className={cn(
                        "overflow-hidden whitespace-nowrap transition-all duration-200 ease-out",
                        thinkingEnabled ? "max-w-20 opacity-100" : "max-w-0 opacity-0",
                      )}
                    >
                      Thinking
                    </span>
                  </button>
                ) : null}
              </div>

              <div className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                {isEditing && onCancelEditing ? (
                  <PromptInputButton
                    className="size-7 rounded-full bg-muted/60 text-red-500/90 ring-1 ring-border/55 transition-colors hover:bg-muted/80 hover:text-red-500"
                    onClick={onCancelEditing}
                    size="icon-sm"
                    tooltip="Cancel edit (Esc)"
                    type="button"
                    variant="ghost"
                  >
                    <X className="size-3.5" />
                    <span className="sr-only">Cancel edit</span>
                  </PromptInputButton>
                ) : null}

                <div
                  className={cn(
                    "transition-opacity",
                    disabled && "cursor-not-allowed opacity-50",
                  )}
                >
                  <PromptInputSubmit
                    aria-disabled={disabled || undefined}
                    className="size-9 shrink-0 rounded-full px-0 shadow-xs"
                    onClick={
                      disabled
                        ? (event) => {
                            event.preventDefault();
                          }
                        : undefined
                    }
                    status={disabled ? "streaming" : undefined}
                    tabIndex={disabled ? -1 : undefined}
                    type={disabled ? "button" : "submit"}
                  >
                    <ArrowUp className="size-4" />
                    <span className="sr-only">Send</span>
                  </PromptInputSubmit>
                </div>
              </div>
            </PromptInputTools>
          </PromptInputFooter>
        </PromptInput>
      </PromptInputProvider>
    </div>
  );
}

function EmptyState({
  onSendMessage,
  composerInitialInput,
  composerResetKey,
  selectedSources,
  availableSkills,
  selectedSkillIds,
  onRemoveSource,
  onSkillSelectionChange,
  searchEnabled,
  onSearchEnabledChange,
  thinkingCapabilities,
  thinkingSettings,
  onThinkingSettingsChange,
}: {
  onSendMessage: (content: string) => void;
  composerInitialInput?: string;
  composerResetKey?: number;
  selectedSources: SourceItem[];
  availableSkills?: ChatSkillItem[];
  selectedSkillIds?: string[];
  onRemoveSource: (id: string) => void;
  onSkillSelectionChange?: (skillIds: string[]) => void;
  searchEnabled?: boolean;
  onSearchEnabledChange?: (enabled: boolean) => void;
  thinkingCapabilities?: PromptThinkingCapabilities;
  thinkingSettings?: PromptThinkingSettings;
  onThinkingSettingsChange?: (settings: PromptThinkingSettings) => void;
}) {
  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="flex min-h-full items-center justify-center px-6 py-10">
          <div className="mx-auto flex w-full max-w-4xl flex-col items-start justify-center gap-8">
            <ConversationEmptyState className="w-full items-start gap-4 p-0 text-left">
              <div className="space-y-2">
                <p className="text-xs font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                  New chat
                </p>
                <div className="space-y-3">
                  <h1 className="max-w-2xl text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                    Work with your agent across your selected sources.
                  </h1>
                  <p className="max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
                    Start with a prompt, compare evidence, or have the agent
                    synthesize what matters most before you open a
                    thread.
                  </p>
                </div>
              </div>
              <Suggestions className="justify-start gap-2 pt-2">
                {starterSuggestions.map((suggestion) => (
                  <Suggestion
                    className="h-auto rounded-full border-border/70 bg-background px-4 py-2 text-sm text-muted-foreground whitespace-normal hover:bg-muted hover:text-foreground"
                    key={suggestion}
                    onClick={onSendMessage}
                    suggestion={suggestion}
                    variant="outline"
                  />
                ))}
              </Suggestions>
            </ConversationEmptyState>
          </div>
        </ConversationContent>
      </Conversation>

      <div className="border-t border-border/60 bg-background/95 px-6 py-5 backdrop-blur">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
          <Composer
            className="w-full"
            initialInput={composerInitialInput}
            inputKey={composerResetKey}
            onRemoveSource={onRemoveSource}
            onSkillSelectionChange={onSkillSelectionChange}
            onSubmit={(message) => onSendMessage(message.text.trim())}
            onSearchEnabledChange={onSearchEnabledChange}
            onThinkingSettingsChange={onThinkingSettingsChange}
            placeholder="Message your documents, links, or connected tools..."
            searchEnabled={searchEnabled}
            availableSkills={availableSkills}
            selectedSkillIds={selectedSkillIds}
            selectedSources={selectedSources}
            thinkingCapabilities={thinkingCapabilities}
            thinkingSettings={thinkingSettings}
          />
        </div>
      </div>
    </section>
  );
}

export function ChatCanvas({
  activeVersionByGroup = {},
  composerInitialInput,
  composerResetKey,
  highlightedMessageId = null,
  isEditing = false,
  isStreaming = false,
  messageGroups = [],
  mode,
  sourcesVisible,
  threadTitle,
  onActiveVersionChange,
  onCancelEditing,
  onCitationClick,
  onRestartFromMessage,
  onRefreshLatest,
  onSendMessage,
  allSources = [],
  selectedSources = [],
  availableSkills = [],
  selectedSkillIds = [],
  onRemoveSource,
  onSkillSelectionChange,
  searchEnabled,
  onSearchEnabledChange,
  workspaceId,
  thinkingCapabilities,
  thinkingSettings,
  onThinkingSettingsChange,
}: {
  activeVersionByGroup?: Record<string, number>;
  composerInitialInput?: string;
  composerResetKey?: number;
  highlightedMessageId?: string | null;
  isEditing?: boolean;
  isStreaming?: boolean;
  messageGroups?: VersionedMessageGroup[];
  mode: "thread" | "new";
  sourcesVisible: boolean;
  threadTitle: string;
  onActiveVersionChange?: (input: { groupId: string; branchIndex: number }) => void;
  onCancelEditing?: () => void;
  onCitationClick?: (citation: CitationRecord) => void;
  onRestartFromMessage?: (input: {
    groupId: string;
    messageId: string;
    message: string;
    assistantMessageId: string | null;
    branchIndex: number;
  }) => void;
  onRefreshLatest?: (input: {
    groupId: string;
    assistantMessageId: string;
    branchIndex: number;
  }) => void;
  onSendMessage?: (content: string) => void;
  allSources?: SourceItem[];
  selectedSources?: SourceItem[];
  availableSkills?: ChatSkillItem[];
  selectedSkillIds?: string[];
  onRemoveSource?: (id: string) => void;
  onSkillSelectionChange?: (skillIds: string[]) => void;
  searchEnabled?: boolean;
  onSearchEnabledChange?: (enabled: boolean) => void;
  workspaceId?: string | null;
  thinkingCapabilities?: PromptThinkingCapabilities;
  thinkingSettings?: PromptThinkingSettings;
  onThinkingSettingsChange?: (settings: PromptThinkingSettings) => void;
}) {
  void sourcesVisible;

  function handleSendMessage(content: string) {
    if (!workspaceId) {
      toast.error("No workspace selected yet.");
      return;
    }
    onSendMessage?.(content);
  }

  if (mode === "new") {
    return (
      <EmptyState
        composerInitialInput={composerInitialInput}
        composerResetKey={composerResetKey}
        onRemoveSource={onRemoveSource ?? (() => undefined)}
        onSkillSelectionChange={onSkillSelectionChange}
        onSearchEnabledChange={onSearchEnabledChange}
        onSendMessage={handleSendMessage}
        onThinkingSettingsChange={onThinkingSettingsChange}
        searchEnabled={searchEnabled}
        availableSkills={availableSkills}
        selectedSkillIds={selectedSkillIds}
        selectedSources={selectedSources}
        thinkingCapabilities={thinkingCapabilities}
        thinkingSettings={thinkingSettings}
      />
    );
  }

  const latestUserGroup = [...messageGroups]
    .reverse()
    .find((group) => group.role === "user");
  const latestAssistantGroup = [...messageGroups]
    .reverse()
    .find((group) => group.role === "assistant");
  const latestUserGroupId = latestUserGroup?.groupId;
  const latestAssistantGroupId = latestAssistantGroup?.groupId;

  async function handleCopyMessage(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Message copied.");
    } catch {
      toast.error("Couldn't copy the message.");
    }
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="px-6 py-8">
          <div className="mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-4">
            {messageGroups.map((group) => {
              const isAssistant = group.role === "assistant";
              const selectedUserVersionIdForAssistant = isAssistant
                ? (() => {
                    const userGroup = group.turnId
                      ? messageGroups.find(
                          (candidate) =>
                            candidate.role === "user" &&
                            candidate.turnId === group.turnId,
                        )
                      : null;
                    if (!userGroup) {
                      return null;
                    }

                    const latestUserVersionIndex = Math.max(
                      userGroup.versions.length - 1,
                      0,
                    );
                    const desiredUserBranchIndexRaw =
                      activeVersionByGroup[userGroup.groupId];
                    const activeUserBranchIndex = Math.min(
                      Math.max(
                        desiredUserBranchIndexRaw ?? latestUserVersionIndex,
                        0,
                      ),
                      latestUserVersionIndex,
                    );
                    return userGroup.versions[activeUserBranchIndex]?.id ?? null;
                  })()
                : null;

              const versionEntries = (() => {
                const allEntries = group.versions.map((version, originalIndex) => ({
                  version,
                  originalIndex,
                }));

                if (!isAssistant || !selectedUserVersionIdForAssistant) {
                  return allEntries;
                }

                const scopedEntries = allEntries.filter(
                  (entry) =>
                    entry.version.sourceUserMessageId ===
                    selectedUserVersionIdForAssistant,
                );

                return scopedEntries.length > 0 ? scopedEntries : allEntries;
              })();

              const latestVisibleVersionIndex = Math.max(
                versionEntries.length - 1,
                0,
              );
              const desiredOriginalBranchIndexRaw =
                activeVersionByGroup[group.groupId];
              const defaultOriginalBranchIndex =
                versionEntries[latestVisibleVersionIndex]?.originalIndex ?? 0;
              const desiredOriginalBranchIndex =
                typeof desiredOriginalBranchIndexRaw === "number"
                  ? desiredOriginalBranchIndexRaw
                  : defaultOriginalBranchIndex;
              const matchedVisibleIndex = versionEntries.findIndex(
                (entry) => entry.originalIndex === desiredOriginalBranchIndex,
              );
              const activeVisibleBranchIndex =
                matchedVisibleIndex >= 0
                  ? matchedVisibleIndex
                  : latestVisibleVersionIndex;
              const activeOriginalBranchIndex =
                versionEntries[activeVisibleBranchIndex]?.originalIndex ?? 0;

              const isLatestUserGroup = group.groupId === latestUserGroupId;
              const isLatestAssistantGroup =
                group.groupId === latestAssistantGroupId;
              const selectedUserVersionId = !isAssistant
                ? (group.versions[activeOriginalBranchIndex]?.id ?? null)
                : null;
              const assistantGroupForUser =
                !isAssistant && selectedUserVersionId
                  ? messageGroups.find(
                      (candidate) =>
                        candidate.role === "assistant" &&
                        candidate.versions.some(
                          (version) =>
                            version.sourceUserMessageId === selectedUserVersionId,
                        ),
                    )
                  : null;
              const selectedAssistantVersionForUser = (() => {
                if (!assistantGroupForUser || !selectedUserVersionId) {
                  return null;
                }

                const maxAssistantIndex = Math.max(
                  assistantGroupForUser.versions.length - 1,
                  0,
                );
                const preferredAssistantIndex = Math.min(
                  Math.max(
                    activeVersionByGroup[assistantGroupForUser.groupId] ??
                      maxAssistantIndex,
                    0,
                  ),
                  maxAssistantIndex,
                );
                const preferredAssistantVersion =
                  assistantGroupForUser.versions[preferredAssistantIndex] ?? null;
                if (
                  preferredAssistantVersion?.sourceUserMessageId ===
                  selectedUserVersionId
                ) {
                  return preferredAssistantVersion;
                }

                for (
                  let index = assistantGroupForUser.versions.length - 1;
                  index >= 0;
                  index -= 1
                ) {
                  const candidate = assistantGroupForUser.versions[index];
                  if (candidate?.sourceUserMessageId === selectedUserVersionId) {
                    return candidate;
                  }
                }

                return null;
              })();
              const sourceById = new Map(allSources.map((source) => [source.id, source]));
              const toolbarVisibilityClass =
                "invisible pointer-events-none opacity-0 transition-opacity duration-150 group-hover/message:visible group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-focus-within/message:visible group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100";

              return (
                <MessageBranch
                  className="group/message flex w-full flex-col gap-1"
                  defaultBranch={activeVisibleBranchIndex}
                  key={`${group.groupId}:${group.latestVersionId}:${selectedUserVersionIdForAssistant ?? "all"}:${activeOriginalBranchIndex}`}
                  onBranchChange={(branchIndex) => {
                    const selectedEntry = versionEntries[branchIndex];
                    if (!selectedEntry) {
                      return;
                    }

                    onActiveVersionChange?.({
                      groupId: group.groupId,
                      branchIndex: selectedEntry.originalIndex,
                    });
                  }}
                >
                  <MessageBranchContent>
                    {versionEntries.map(({ version }, versionIndex) => {
                      const messageText = getMessageText(version);
                      const isStreamingThisVersion =
                        isStreaming &&
                        isAssistant &&
                        isLatestAssistantGroup &&
                        versionIndex === activeVisibleBranchIndex;
                      const referencedSources = !isAssistant
                        ? (version.sourceIds ?? [])
                            .map((sourceId) => sourceById.get(sourceId))
                            .filter((source): source is SourceItem => Boolean(source))
                        : [];

                        return (
                          <div
                            className={cn(
                              "flex w-full flex-col gap-1 rounded-2xl transition-colors duration-700",
                              highlightedMessageId === version.id &&
                                "bg-primary/10 ring-1 ring-primary/25",
                            )}
                            data-chat-message-id={version.id}
                            key={version.id}
                          >
                          {!isAssistant && referencedSources.length > 0 ? (
                            <ReferencedFiles sources={referencedSources} />
                          ) : null}
                          <Message from={group.role}>
                            <MessageContent
                              className={
                                isAssistant
                                  ? "max-w-none"
                                  : "w-fit max-w-full rounded-3xl bg-secondary px-4 py-3 text-foreground shadow-sm"
                              }
                            >
                              {!isAssistant ? (
                                <div className="whitespace-pre-wrap break-words leading-6">
                                  {messageText}
                                </div>
                              ) : version.isError ? (
                                <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                                  <p className="font-medium">Message failed</p>
                                  <p className="mt-1 whitespace-pre-wrap break-words text-destructive/90">
                                    {messageText}
                                  </p>
                                </div>
                              ) : (
                                <div className="space-y-3">
                                  <ReasoningTrace
                                    isStreaming={isStreamingThisVersion}
                                    modelReasoning={version.modelReasoning}
                                    modelReasoningSegments={version.modelReasoningSegments}
                                    steps={version.thinkingSteps}
                                    toolCalls={version.toolCalls}
                                  />
                                  <CitationAwareMessageResponse
                                    availableCitations={version.availableCitations}
                                    citations={version.citations}
                                    onCitationClick={onCitationClick}
                                    showLoading={
                                      isStreamingThisVersion &&
                                      version.isTextPaused === true &&
                                      messageText.length > 0
                                    }
                                  >
                                    {messageText}
                                  </CitationAwareMessageResponse>
                                </div>
                              )}
                            </MessageContent>
                          </Message>

                          <MessageToolbar
                            className={cn(
                              "mt-0.5 min-h-7 px-1 text-xs text-muted-foreground transition-opacity duration-150",
                              isAssistant ? "justify-start" : "justify-end",
                              toolbarVisibilityClass,
                            )}
                          >
                            <div className="flex items-center gap-1">
                              <MessageActions>
                                <MessageAction
                                  className="text-muted-foreground hover:text-foreground"
                                  label="Copy"
                                  onClick={() => void handleCopyMessage(messageText)}
                                  size="icon-sm"
                                  tooltip="Copy"
                                  type="button"
                                  variant="ghost"
                                >
                                  <Copy className="size-3" />
                                </MessageAction>

                                {!isAssistant &&
                                isLatestUserGroup &&
                                versionIndex === activeVisibleBranchIndex &&
                                !isStreaming ? (
                                  <MessageAction
                                    className="text-muted-foreground hover:text-foreground"
                                    label="Edit prompt"
                                    onClick={() => {
                                      onRestartFromMessage?.({
                                        groupId: group.groupId,
                                        message: messageText,
                                        messageId: version.id,
                                        assistantMessageId:
                                          selectedAssistantVersionForUser?.id ?? null,
                                        branchIndex: activeOriginalBranchIndex,
                                      });
                                    }}
                                    size="icon-sm"
                                    tooltip="Edit and restart"
                                    type="button"
                                    variant="ghost"
                                  >
                                    <Pencil className="size-3" />
                                  </MessageAction>
                                ) : null}

                                {isAssistant &&
                                isLatestAssistantGroup &&
                                versionIndex === activeVisibleBranchIndex &&
                                !isStreaming ? (
                                  <MessageAction
                                    className="text-muted-foreground hover:text-foreground"
                                    label="Refresh"
                                    onClick={() => {
                                      onRefreshLatest?.({
                                        groupId: group.groupId,
                                        assistantMessageId: version.id,
                                        branchIndex: activeOriginalBranchIndex,
                                      });
                                    }}
                                    size="icon-sm"
                                    tooltip="Refresh"
                                    type="button"
                                    variant="ghost"
                                  >
                                    <RotateCcw className="size-3" />
                                  </MessageAction>
                                ) : null}
                              </MessageActions>

                              <MessageBranchSelector>
                                <MessageBranchPrevious className="text-muted-foreground hover:text-foreground" />
                                <MessageBranchPage />
                                <MessageBranchNext className="text-muted-foreground hover:text-foreground" />
                              </MessageBranchSelector>
                            </div>
                          </MessageToolbar>
                        </div>
                      );
                    })}
                  </MessageBranchContent>
                </MessageBranch>
              );
            })}
          </div>
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="border-t border-border/60 bg-background/95 px-6 py-5 backdrop-blur">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
          <Composer
            className="w-full"
            disabled={isStreaming}
            initialInput={composerInitialInput}
            isEditing={isEditing}
            inputKey={`${threadTitle}-${composerResetKey ?? 0}`}
            onCancelEditing={onCancelEditing}
            onRemoveSource={onRemoveSource}
            onSkillSelectionChange={onSkillSelectionChange}
            onSearchEnabledChange={onSearchEnabledChange}
            onSubmit={(message) =>
              handleSendMessage(message.text.trim())
            }
            onThinkingSettingsChange={onThinkingSettingsChange}
            searchEnabled={searchEnabled}
            availableSkills={availableSkills}
            selectedSkillIds={selectedSkillIds}
            selectedSources={selectedSources}
            thinkingCapabilities={thinkingCapabilities}
            thinkingSettings={thinkingSettings}
          />
        </div>
      </div>
    </section>
  );
}
