import { useEffect, useRef, useState } from "react";
import { Loader2, WrenchIcon } from "lucide-react";
import {
  isGeneratedImageArtifactToolName,
  isRetrievalToolName,
  isWebFetchToolName,
  isWebSearchToolName,
  isWebToolName,
} from "@sourceweft/sdk";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
} from "@sourceweft/ui-web/components/ai-elements/chain-of-thought";
import { Shimmer } from "@sourceweft/ui-web/components/ai-elements/shimmer";
import { hasWebPageToolResults } from "../web-tool-results";
import {
  compactText,
  getToolOutputContent,
  resolveArtifactUrl,
  resolveGeneratedImageArtifact,
} from "./message-assets";
import type {
  ModelReasoningSegmentRecord,
  ThinkingStepRecord,
  ToolCallRecord,
} from "./types";

function getRecordValue(
  record: Record<string, unknown> | undefined,
  key: string,
) {
  return record ? record[key] : undefined;
}

function getToolQuery(toolCall: ToolCallRecord, toolStep?: ThinkingStepRecord) {
  const inputQuery = getRecordValue(toolCall.input, "query");
  if (typeof inputQuery === "string" && inputQuery.trim().length > 0) {
    return inputQuery.trim();
  }

  const output =
    toolCall.output && typeof toolCall.output === "object"
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

function getToolHitCount(
  toolCall: ToolCallRecord,
  toolStep?: ThinkingStepRecord,
) {
  const output =
    toolCall.output && typeof toolCall.output === "object"
      ? (toolCall.output as Record<string, unknown>)
      : undefined;
  const outputHitCount = getRecordValue(output, "hitCount");
  if (typeof outputHitCount === "number" && Number.isFinite(outputHitCount)) {
    return outputHitCount;
  }

  const metadataHitCount = getRecordValue(toolStep?.metadata, "hitCount");
  return typeof metadataHitCount === "number" &&
    Number.isFinite(metadataHitCount)
    ? metadataHitCount
    : null;
}

function getToolResultCount(
  toolCall: ToolCallRecord,
  toolStep?: ThinkingStepRecord,
) {
  const output =
    toolCall.output && typeof toolCall.output === "object"
      ? (toolCall.output as Record<string, unknown>)
      : undefined;
  const outputCount =
    getRecordValue(output, "resultCount") ?? getRecordValue(output, "urlCount");
  if (typeof outputCount === "number" && Number.isFinite(outputCount)) {
    return outputCount;
  }

  const metadataCount = getRecordValue(toolStep?.metadata, "resultCount");
  return typeof metadataCount === "number" && Number.isFinite(metadataCount)
    ? metadataCount
    : null;
}

function getToolFetchUrls(toolCall: ToolCallRecord) {
  const items = getRecordValue(toolCall.input, "items");
  if (!Array.isArray(items)) {
    return [] as string[];
  }

  return items
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const url = (item as Record<string, unknown>).url;
      return typeof url === "string" && url.trim().length > 0
        ? url.trim()
        : null;
    })
    .filter((url): url is string => url !== null);
}

function getToolFetchCount(
  toolCall: ToolCallRecord,
  toolStep?: ThinkingStepRecord,
) {
  const urls = getToolFetchUrls(toolCall);
  if (urls.length > 0) {
    return urls.length;
  }

  const metadataUrlCount = getRecordValue(toolStep?.metadata, "urlCount");
  return typeof metadataUrlCount === "number" &&
    Number.isFinite(metadataUrlCount)
    ? metadataUrlCount
    : null;
}

function getToolConcurrency(toolStep?: ThinkingStepRecord) {
  const concurrency = getRecordValue(toolStep?.metadata, "concurrency");
  return typeof concurrency === "number" && Number.isFinite(concurrency)
    ? concurrency
    : null;
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function summarizeToolOutput(output: unknown) {
  const content = getToolOutputContent(output);
  return content ? compactText(content) : null;
}

function formatToolName(toolName: string) {
  return toolName
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function getWebSearchStatusLabel(status: ToolCallRecord["status"]) {
  if (status === "running") {
    return "Searching web";
  }
  if (status === "error") {
    return "Web search failed";
  }
  return "Searched web";
}

function getWebFetchStatusLabel(status: ToolCallRecord["status"]) {
  if (status === "running") {
    return "Fetching pages";
  }
  if (status === "error") {
    return "Page fetch failed";
  }
  return "Fetched pages";
}

function getToolDisplayLabel(toolCall: ToolCallRecord) {
  if (isRetrievalToolName(toolCall.tool)) {
    const query = getToolQuery(toolCall);
    return query
      ? `Search sources: ${compactText(query, 72)}`
      : "Search sources";
  }

  if (isWebSearchToolName(toolCall.tool)) {
    const query = getToolQuery(toolCall);
    const verb = getWebSearchStatusLabel(toolCall.status);
    return query ? `${verb}: ${compactText(query, 72)}` : verb;
  }

  if (isWebFetchToolName(toolCall.tool)) {
    const urls = getToolFetchUrls(toolCall);
    const count = urls.length;
    const firstUrl = urls[0] ? compactText(urls[0], 56) : null;
    const verb = getWebFetchStatusLabel(toolCall.status);
    if (count > 0 && firstUrl) {
      const suffix = count > 1 ? ` +${count - 1}` : "";
      return `${verb}: ${firstUrl}${suffix}`;
    }
    return verb;
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

  return inputPreview
    ? `${prefix} ${toolName} (${inputPreview})`
    : `${prefix} ${toolName}`;
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

function getThinkingMetadataParts(
  metadata: Record<string, unknown> | undefined,
) {
  if (!metadata) {
    return [] as string[];
  }

  const labels: Record<string, string> = {
    availableCitationCount: "available citations",
    chunkCount: "chunks",
    hitCount: "hits",
    latencyMs: "time",
    limit: "limit",
    matchCount: "matches",
    pageCount: "pages",
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

function getToolStepMetadataParts(
  metadata: Record<string, unknown> | undefined,
) {
  if (!metadata) {
    return [] as string[];
  }

  const rest = { ...metadata };
  delete rest.concurrency;
  delete rest.hitCount;
  delete rest.latencyMs;
  delete rest.limit;
  delete rest.pageCount;
  delete rest.query;
  delete rest.resultCount;
  delete rest.urlCount;
  return getThinkingMetadataParts(rest);
}

function getToolCallDetailParts(
  toolCall: ToolCallRecord,
  toolStep?: ThinkingStepRecord,
) {
  const hitCount = getToolHitCount(toolCall, toolStep);
  const resultCount = isWebSearchToolName(toolCall.tool)
    ? getToolResultCount(toolCall, toolStep)
    : null;
  const fetchCount = isWebFetchToolName(toolCall.tool)
    ? getToolFetchCount(toolCall, toolStep)
    : null;
  const concurrency = isWebFetchToolName(toolCall.tool)
    ? getToolConcurrency(toolStep)
    : null;
  const latencyMs =
    toolCall.latencyMs ??
    (typeof toolStep?.metadata?.latencyMs === "number"
      ? toolStep.metadata.latencyMs
      : null);
  return [
    `status: ${toolCall.status}`,
    hitCount !== null ? `hits: ${hitCount}` : null,
    resultCount !== null
      ? `${resultCount} ${pluralize(resultCount, "result")}`
      : null,
    fetchCount !== null
      ? `${fetchCount} ${pluralize(fetchCount, "URL")}`
      : null,
    concurrency !== null ? `concurrency: ${concurrency}` : null,
    typeof latencyMs === "number" ? `time: ${Math.round(latencyMs)}ms` : null,
  ].filter((part): part is string => part !== null);
}

function ToolCallDetails({
  toolCall,
  toolStep,
  workspaceId,
}: {
  toolCall: ToolCallRecord;
  toolStep?: ThinkingStepRecord;
  workspaceId?: string | null;
}) {
  const query = getToolQuery(toolCall, toolStep);
  const shouldShowQuery = Boolean(query && !isRetrievalToolName(toolCall.tool));
  const fetchUrls = getToolFetchUrls(toolCall);
  const outputSummary = summarizeToolOutput(toolCall.output);
  const imageArtifact = resolveGeneratedImageArtifact(toolCall, toolStep);
  const imageUrl = imageArtifact
    ? resolveArtifactUrl({ artifact: imageArtifact, workspaceId })
    : null;
  const shouldShowOutputSummary = Boolean(
    outputSummary &&
      !imageArtifact &&
      !isRetrievalToolName(toolCall.tool) &&
      !isWebToolName(toolCall.tool) &&
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
      {fetchUrls.length > 0 && !hasWebPageToolResults([toolCall]) ? (
        <div>
          <span className="font-medium text-foreground/80">URLs:</span>{" "}
          {fetchUrls.slice(0, 5).map((url, index) => (
            <span key={url}>
              {index > 0 ? ", " : null}
              {compactText(url, 80)}
            </span>
          ))}
        </div>
      ) : null}
      {imageArtifact && imageUrl ? (
        <p>
          <span className="font-medium text-foreground/80">Artifact:</span>{" "}
          <a
            className="text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
            href={imageUrl}
            rel="noreferrer"
            target="_blank"
          >
            {imageArtifact.title ?? "Open generated image"}
          </a>
        </p>
      ) : null}
      {shouldShowOutputSummary ? <p>{outputSummary}</p> : null}
      {toolCall.error ? (
        <p className="text-destructive">{toolCall.error}</p>
      ) : null}
    </div>
  );
}

export function GeneratedImageArtifacts({
  toolCalls,
  workspaceId,
}: {
  toolCalls: ToolCallRecord[] | undefined;
  workspaceId?: string | null;
}) {
  const imageItems = (toolCalls ?? [])
    .filter((toolCall) => isGeneratedImageArtifactToolName(toolCall.tool))
    .map((toolCall) => {
      const artifact = resolveGeneratedImageArtifact(toolCall);
      const imageUrl = artifact
        ? resolveArtifactUrl({ artifact, workspaceId })
        : null;
      return {
        artifact,
        imageUrl,
        toolCall,
      };
    })
    .filter(({ imageUrl, toolCall }) => {
      if (toolCall.status === "running" || toolCall.status === "error") {
        return true;
      }
      return Boolean(imageUrl);
    });

  if (imageItems.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      {imageItems.map(({ artifact, imageUrl, toolCall }) => {
        const title =
          artifact?.title ||
          (typeof toolCall.input.title === "string"
            ? toolCall.input.title
            : null) ||
          "Generated image";

        if (toolCall.status === "running") {
          return (
            <div
              aria-label="Generating image"
              className="relative isolate aspect-[4/3] max-h-[520px] w-full max-w-xl overflow-hidden rounded-lg border border-border bg-muted shadow-sm"
              key={toolCall.id}
              role="status"
            >
              <div className="absolute inset-0 bg-[linear-gradient(135deg,hsl(var(--muted))_0%,hsl(var(--background))_42%,hsl(var(--muted))_100%)]" />
              <div className="absolute inset-0 opacity-70 [background-image:radial-gradient(circle_at_24%_18%,hsl(var(--primary)/0.18),transparent_30%),radial-gradient(circle_at_78%_64%,hsl(var(--foreground)/0.08),transparent_28%)]" />
              <div className="absolute inset-0 animate-pulse bg-[linear-gradient(100deg,transparent_0%,hsl(var(--foreground)/0.04)_34%,hsl(var(--foreground)/0.12)_50%,hsl(var(--foreground)/0.04)_66%,transparent_100%)]" />
              <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-background/85 via-background/45 to-transparent" />
              <div className="absolute inset-4 rounded-md border border-background/50 bg-background/10 shadow-inner" />
              <div className="absolute right-4 bottom-4 left-4 flex items-center justify-between gap-3 rounded-md border border-border/70 bg-background/80 px-3 py-2 shadow-sm backdrop-blur-md">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-foreground">
                    {title}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Generating image
                  </p>
                </div>
                <Loader2
                  className="size-4 shrink-0 animate-spin text-muted-foreground"
                  aria-hidden
                />
              </div>
            </div>
          );
        }

        if (toolCall.status === "error") {
          return (
            <div
              className="max-w-xl rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              key={toolCall.id}
            >
              {toolCall.error ?? "Image generation failed."}
            </div>
          );
        }

        if (!imageUrl) {
          return null;
        }

        return (
          <a
            className="block max-w-xl"
            href={imageUrl}
            key={toolCall.id}
            rel="noreferrer"
            target="_blank"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- Generated artifact URLs can be API-backed and are already rendered lazily. */}
            <img
              alt={title}
              className="max-h-[520px] max-w-full rounded-lg border border-border bg-muted/20 object-contain shadow-sm"
              loading="lazy"
              src={imageUrl}
            />
          </a>
        );
      })}
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

export function ReasoningTrace({
  isStreaming,
  modelReasoning,
  modelReasoningSegments,
  steps,
  toolCalls,
  workspaceId,
}: {
  isStreaming: boolean;
  modelReasoning?: string;
  modelReasoningSegments?: ModelReasoningSegmentRecord[];
  steps: ThinkingStepRecord[] | undefined;
  toolCalls: ToolCallRecord[] | undefined;
  workspaceId?: string | null;
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
  const displayReasoningSegments =
    safeReasoningSegments.length > 0
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
        return typeof toolCallId === "string"
          ? ([toolCallId, step] as const)
          : null;
      })
      .filter(
        (entry): entry is readonly [string, ThinkingStepRecord] =>
          entry !== null,
      ),
  );
  const toolCallIds = new Set(safeToolCalls.map((toolCall) => toolCall.id));
  const displaySteps = safeSteps.filter((step) => {
    const toolCallId = step.metadata?.toolCallId;
    return !(typeof toolCallId === "string" && toolCallIds.has(toolCallId));
  });
  const activeStep = safeSteps.find((step) => step.status === "in_progress");
  const hasRunningToolCall = safeToolCalls.some(
    (toolCall) => toolCall.status === "running",
  );
  const isThinking = isStreaming || Boolean(activeStep) || hasRunningToolCall;
  const hasTraceItems =
    safeSteps.length + safeToolCalls.length + (hasModelReasoning ? 1 : 0) > 0;
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
  const reasoningDurationMs = displayReasoningSegments.reduce<
    number | undefined
  >((longest, segment) => {
    if (typeof segment.durationMs !== "number") {
      return longest;
    }

    return Math.max(longest ?? 0, segment.durationMs);
  }, undefined);

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
        icon={
          isThinking ? <Loader2 className="size-4 animate-spin" /> : undefined
        }
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">
            {isThinking ? <Shimmer duration={1}>{title}</Shimmer> : title}
          </span>
          {isThinking ? (
            <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 font-medium text-[11px] text-primary">
              Running
            </span>
          ) : null}
        </span>
      </ChainOfThoughtHeader>
      {isOpen && timelineItems.length > 0 ? (
        <ChainOfThoughtContent
          className="max-h-64 overflow-y-auto pr-1"
          ref={contentRef}
        >
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
              const stepDescription =
                [
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
                        <ChainOfThoughtSearchResult
                          key={`${step.id}:${result}`}
                          title={result}
                        >
                          <span className="max-w-[220px] truncate">
                            {result}
                          </span>
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
            const summary =
              [
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
                <ToolCallDetails
                  toolCall={toolCall}
                  toolStep={toolStep}
                  workspaceId={workspaceId}
                />
              </ChainOfThoughtStep>
            );
          })}
        </ChainOfThoughtContent>
      ) : null}
    </ChainOfThought>
  );
}
