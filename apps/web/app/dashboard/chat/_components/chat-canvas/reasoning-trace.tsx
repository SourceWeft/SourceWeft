import { useEffect, useRef, useState } from "react";
import { ImageIcon, Loader2, WrenchIcon } from "lucide-react";
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
  ChainOfThoughtImage,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
} from "@sourceweft/ui-web/components/ai-elements/chain-of-thought";
import { Shimmer } from "@sourceweft/ui-web/components/ai-elements/shimmer";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { hasWebPageToolResults } from "../web-tool-results";
import { getToolConfirmationOutput } from "./tool-confirmation";
import {
  compactText,
  getToolOutputContent,
  normalizeAssetUrl,
  resolveArtifactDownloadUrl,
  resolveArtifactUrl,
  resolveGeneratedImageArtifact,
} from "./message-assets";
import { GeneratedImagePreview } from "./generated-image-preview";
import type {
  ArtifactPreviewRecord,
  ModelReasoningSegmentRecord,
  ThinkingStepRecord,
  ToolCallRecord,
} from "./types";

const GENERATED_IMAGE_DEFAULT_ASPECT_RATIO = "4 / 3";

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
  const confirmation = getToolConfirmationOutput(output);
  if (confirmation) {
    return null;
  }
  const content = getToolOutputContent(output);
  return content ? compactText(content) : null;
}

function parseAspectRatio(value: unknown) {
  if (typeof value !== "string" || value === "auto") {
    return null;
  }

  const match = value.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) {
    return null;
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0) {
    return null;
  }

  return `${width} / ${height}`;
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

const GENERATED_IMAGE_STAGE_LABELS: Record<string, string> = {
  billing: "Finalizing",
  generating: "Rendering",
  preparing: "Composing",
  ready: "Ready",
  saving: "Polishing",
};

const GENERATED_IMAGE_STAGE_INDEX: Record<string, number> = {
  preparing: 0,
  generating: 1,
  saving: 2,
  billing: 3,
  ready: 4,
};

function getGeneratedImageStatus(toolCall: ToolCallRecord) {
  const output =
    toolCall.output && typeof toolCall.output === "object"
      ? (toolCall.output as Record<string, unknown>)
      : undefined;
  const input = toolCall.input;
  const stage = getRecordValue(output, "stage");
  const normalizedStage =
    typeof stage === "string" && stage.trim().length > 0
      ? stage.trim()
      : null;
  const outputWidth = getRecordValue(output, "width");
  const outputHeight = getRecordValue(output, "height");
  const width =
    typeof outputWidth === "number" && Number.isFinite(outputWidth)
      ? outputWidth
      : null;
  const height =
    typeof outputHeight === "number" && Number.isFinite(outputHeight)
      ? outputHeight
      : null;
  const aspectRatio =
    width && height && height > 0
      ? `${width} / ${height}`
      : parseAspectRatio(getRecordValue(output, "aspectRatio")) ??
        parseAspectRatio(getRecordValue(input, "aspectRatio")) ??
        GENERATED_IMAGE_DEFAULT_ASPECT_RATIO;

  return {
    aspectRatio,
    label: normalizedStage
      ? (GENERATED_IMAGE_STAGE_LABELS[normalizedStage] ??
        formatToolName(normalizedStage))
      : null,
    progress:
      normalizedStage && normalizedStage in GENERATED_IMAGE_STAGE_INDEX
        ? GENERATED_IMAGE_STAGE_INDEX[normalizedStage]
        : null,
    stage: normalizedStage,
  };
}

function getGeneratedImageTitle(toolCall: ToolCallRecord) {
  const output =
    toolCall.output && typeof toolCall.output === "object"
      ? (toolCall.output as Record<string, unknown>)
      : undefined;
  const outputTitle = getRecordValue(output, "title");
  if (typeof outputTitle === "string" && outputTitle.trim().length > 0) {
    return outputTitle.trim();
  }

  const inputTitle = getRecordValue(toolCall.input, "title");
  if (typeof inputTitle === "string" && inputTitle.trim().length > 0) {
    return inputTitle.trim();
  }

  const prompt = getRecordValue(toolCall.input, "prompt");
  return typeof prompt === "string" && prompt.trim().length > 0
    ? compactText(prompt, 72)
    : null;
}

function getGeneratedImagePrompt(toolCall: ToolCallRecord) {
  const prompt = getRecordValue(toolCall.input, "prompt");
  if (typeof prompt === "string" && prompt.trim().length > 0) {
    return prompt.trim();
  }

  const output =
    toolCall.output && typeof toolCall.output === "object"
      ? (toolCall.output as Record<string, unknown>)
      : undefined;
  const outputPrompt = getRecordValue(output, "prompt");
  return typeof outputPrompt === "string" && outputPrompt.trim().length > 0
    ? outputPrompt.trim()
    : null;
}

function getToolDisplayLabel(toolCall: ToolCallRecord) {
  const confirmation = getToolConfirmationOutput(toolCall.output);
  if (confirmation) {
    const toolName = formatToolName(toolCall.tool);
    if (toolCall.status === "error") {
      return `${toolName} approval failed`;
    }
    return `${toolName} waiting for approval`;
  }

  if (isGeneratedImageArtifactToolName(toolCall.tool)) {
    const title = getGeneratedImageTitle(toolCall);
    const imageStatus = getGeneratedImageStatus(toolCall);
    const verb =
      toolCall.status === "running"
        ? (imageStatus.label ?? "Generating image")
        : toolCall.status === "error"
          ? "Image generation failed"
          : "Generated image";
    return title ? `${verb}: ${compactText(title, 72)}` : verb;
  }

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

type VisionFallbackImageTrace = {
  description: string;
  fileName: string;
  imageId: string;
  mimeType: string | null;
  url: string;
};

function getMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
) {
  const value = getRecordValue(metadata, key);
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function getVisionFallbackImages(
  metadata: Record<string, unknown> | undefined,
) {
  const images = getRecordValue(metadata, "images");
  if (!Array.isArray(images)) {
    return [] as VisionFallbackImageTrace[];
  }

  return images
    .map((item): VisionFallbackImageTrace | null => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const record = item as Record<string, unknown>;
      const fileName =
        typeof record.fileName === "string" && record.fileName.trim()
          ? record.fileName.trim()
          : "image";
      const imageId =
        typeof record.imageId === "string" && record.imageId.trim()
          ? record.imageId.trim()
          : fileName;
      const url =
        typeof record.url === "string" && record.url.trim()
          ? normalizeAssetUrl(record.url.trim())
          : null;
      if (!url) {
        return null;
      }

      return {
        description:
          typeof record.description === "string"
            ? record.description.trim()
            : "",
        fileName,
        imageId,
        mimeType:
          typeof record.mimeType === "string" && record.mimeType.trim()
            ? record.mimeType.trim()
            : null,
        url,
      };
    })
    .filter((item): item is VisionFallbackImageTrace => item !== null);
}

function isVisionFallbackStep(step: ThinkingStepRecord) {
  return step.metadata?.strategy === "vision_fallback";
}

function VisionFallbackStepDetails({ step }: { step: ThinkingStepRecord }) {
  const images = getVisionFallbackImages(step.metadata);
  const visionModelAlias = getMetadataString(step.metadata, "visionModelAlias");
  const chatModelAlias = getMetadataString(step.metadata, "chatModelAlias");

  return (
    <div className="space-y-3 text-muted-foreground text-xs leading-5">
      {visionModelAlias || chatModelAlias ? (
        <p>
          {visionModelAlias ? (
            <>
              <span className="font-medium text-foreground/80">
                Vision model:
              </span>{" "}
              {visionModelAlias}
            </>
          ) : null}
          {visionModelAlias && chatModelAlias ? " · " : null}
          {chatModelAlias ? (
            <>
              <span className="font-medium text-foreground/80">
                Chat model:
              </span>{" "}
              {chatModelAlias}
            </>
          ) : null}
        </p>
      ) : null}
      {images.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {images.map((image) => (
            <ChainOfThoughtImage
              caption={
                image.description
                  ? compactText(image.description, 220)
                  : image.fileName
              }
              className="mt-0"
              key={image.imageId}
            >
              <img
                alt={image.fileName}
                className="max-h-40 w-full object-contain"
                height={160}
                src={image.url}
                width={240}
              />
            </ChainOfThoughtImage>
          ))}
        </div>
      ) : step.items.length > 0 ? (
        <ChainOfThoughtSearchResults>
          {step.items.map((result) => (
            <ChainOfThoughtSearchResult
              key={`${step.id}:${result}`}
              title={result}
            >
              <span className="max-w-[220px] truncate">{result}</span>
            </ChainOfThoughtSearchResult>
          ))}
        </ChainOfThoughtSearchResults>
      ) : null}
    </div>
  );
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
  const imageStatus = isGeneratedImageArtifactToolName(toolCall.tool)
    ? getGeneratedImageStatus(toolCall)
    : null;
  const imagePrompt = isGeneratedImageArtifactToolName(toolCall.tool)
    ? getGeneratedImagePrompt(toolCall)
    : null;
  return [
    `status: ${toolCall.status}`,
    imageStatus?.stage ? `stage: ${imageStatus.stage}` : null,
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
  onArtifactPreview,
  toolCall,
  toolStep,
  workspaceId,
}: {
  onArtifactPreview?: (artifact: ArtifactPreviewRecord) => void;
  toolCall: ToolCallRecord;
  toolStep?: ThinkingStepRecord;
  workspaceId?: string | null;
}) {
  const query = getToolQuery(toolCall, toolStep);
  const shouldShowQuery = Boolean(query && !isRetrievalToolName(toolCall.tool));
  const fetchUrls = getToolFetchUrls(toolCall);
  const outputSummary = summarizeToolOutput(toolCall.output);
  const toolConfirmation = getToolConfirmationOutput(toolCall.output);
  const imageArtifact = resolveGeneratedImageArtifact(toolCall, toolStep);
  const imageStatus = isGeneratedImageArtifactToolName(toolCall.tool)
    ? getGeneratedImageStatus(toolCall)
    : null;
  const imagePrompt = isGeneratedImageArtifactToolName(toolCall.tool)
    ? getGeneratedImagePrompt(toolCall)
    : null;
  const imageUrl = imageArtifact
    ? resolveArtifactUrl({ artifact: imageArtifact, workspaceId })
    : null;
  const previewArtifact =
    imageArtifact?.artifactId && workspaceId && imageUrl
      ? ({
          id: imageArtifact.artifactId,
          teamId: "",
          workspaceId,
          threadId: null,
          artifactType: "image",
          status: "ready",
          title: imageArtifact.title ?? getGeneratedImageTitle(toolCall),
          promptText: getGeneratedImagePrompt(toolCall),
          payloadJson: {},
          storageBucket: null,
          storageKey: imageArtifact.artifactId,
          errorCode: null,
          errorMessage: null,
          createdBy: null,
          completedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          previewUrl: imageUrl,
        } satisfies ArtifactPreviewRecord)
      : null;
  const shouldShowOutputSummary = Boolean(
    outputSummary &&
      !imageArtifact &&
      !toolConfirmation &&
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
      {imageStatus?.label ? (
        <p>
          <span className="font-medium text-foreground/80">Stage:</span>{" "}
          {imageStatus.label}
        </p>
      ) : null}
      {imagePrompt ? (
        <p>
          <span className="font-medium text-foreground/80">Prompt:</span>{" "}
          {imagePrompt}
        </p>
      ) : null}
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
          <button
            className="text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            onClick={() => {
              if (previewArtifact && onArtifactPreview) {
                onArtifactPreview(previewArtifact);
                return;
              }
              window.open(imageUrl, "_blank", "noopener,noreferrer");
            }}
            type="button"
          >
            {imageArtifact.title ?? "Open generated image"}
          </button>
        </p>
      ) : null}
      {toolConfirmation ? (
        <p>
          Waiting for your decision before this action runs.
        </p>
      ) : null}
      {shouldShowOutputSummary ? <p>{outputSummary}</p> : null}
      {toolCall.error ? (
        <p className="text-destructive">{toolCall.error}</p>
      ) : null}
    </div>
  );
}

function GeneratedImageLoadingMask({
  isVisible,
  stageIndex,
  stageLabel,
  title,
}: {
  isVisible: boolean;
  stageIndex: number | null;
  stageLabel: string;
  title: string;
}) {
  return (
    <div
      aria-hidden={!isVisible}
      aria-label="Generating image"
      className={cn(
        "absolute inset-0 z-10 overflow-hidden rounded-lg transition-opacity duration-500",
        isVisible ? "opacity-100" : "pointer-events-none opacity-0",
      )}
      role={isVisible ? "status" : undefined}
    >
      <div className="absolute inset-0 bg-[linear-gradient(145deg,hsl(var(--background))_0%,hsl(var(--muted))_44%,hsl(var(--background))_100%)]" />
      <div className="absolute inset-0 opacity-80 [background-image:radial-gradient(circle_at_18%_18%,hsl(var(--primary)/0.18),transparent_30%),radial-gradient(circle_at_82%_72%,hsl(var(--foreground)/0.10),transparent_30%)]" />
      <div className="absolute inset-0 bg-[linear-gradient(105deg,transparent_0%,hsl(var(--foreground)/0.04)_30%,hsl(var(--foreground)/0.14)_48%,hsl(var(--foreground)/0.05)_66%,transparent_100%)] bg-[length:220%_100%] animate-[image-sheen_2.2s_ease-in-out_infinite]" />
      <div className="absolute inset-0 opacity-35 [background-image:linear-gradient(hsl(var(--foreground)/0.08)_1px,transparent_1px),linear-gradient(90deg,hsl(var(--foreground)/0.08)_1px,transparent_1px)] [background-size:40px_40px]" />
      <div className="absolute inset-5 rounded-md border border-background/60 bg-background/10 shadow-[inset_0_1px_0_hsl(var(--background)/0.65)]" />
      <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-background/90 via-background/45 to-transparent" />
      <div className="absolute right-4 bottom-4 left-4">
        <div className="rounded-md border border-border/70 bg-background/80 px-3 py-2 shadow-lg backdrop-blur-md">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-foreground">
                {title}
              </p>
              <p className="text-[11px] text-muted-foreground">{stageLabel}</p>
            </div>
            <div className="grid size-6 shrink-0 place-items-center rounded-full border border-border/70 bg-background/70">
              <div className="size-2 rounded-full bg-primary shadow-[0_0_18px_hsl(var(--primary)/0.55)]" />
            </div>
          </div>
          <div className="mt-2 grid grid-cols-5 gap-1">
            {Array.from({ length: 5 }).map((_, index) => (
              <div
                className={cn(
                  "h-1 rounded-full transition-colors duration-300",
                  stageIndex !== null && index <= stageIndex
                    ? "bg-primary"
                    : "bg-muted-foreground/20",
                )}
                key={index}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function GeneratedImageArtifactItem({
  aspectRatio,
  downloadUrl,
  imageUrl,
  stageLabel,
  stageProgress,
  status,
  title,
}: {
  aspectRatio: string;
  downloadUrl?: string | null;
  imageUrl?: string | null;
  stageLabel: string;
  stageProgress: number | null;
  status: ToolCallRecord["status"];
  title: string;
}) {
  const [isImageLoaded, setIsImageLoaded] = useState(false);
  const showMask = status === "running" || Boolean(imageUrl && !isImageLoaded);

  useEffect(() => {
    setIsImageLoaded(false);
  }, [imageUrl]);

  if (!imageUrl) {
    return (
      <div
        className="relative isolate max-h-[520px] w-full max-w-xl overflow-hidden rounded-lg border border-dashed border-border bg-muted"
        style={{ aspectRatio }}
      >
        <GeneratedImageLoadingMask
          isVisible={status === "running"}
          stageIndex={stageProgress}
          stageLabel={stageLabel}
          title={title}
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative isolate max-h-[520px] w-full max-w-xl overflow-hidden rounded-lg bg-muted",
        isImageLoaded && "bg-transparent",
      )}
      style={{ aspectRatio }}
    >
      <GeneratedImagePreview
        className={cn(
          "size-full transition-opacity duration-200 [&>span]:size-full [&>span]:min-h-0 [&>span]:min-w-0 [&>span>img]:h-full [&>span>img]:w-full [&>span>img]:object-contain",
          isImageLoaded ? "opacity-100" : "opacity-0",
        )}
        downloadUrl={downloadUrl ?? imageUrl}
        imageUrl={imageUrl}
        onImageLoad={() => setIsImageLoaded(true)}
        title={title}
      />
      <GeneratedImageLoadingMask
        isVisible={showMask}
        stageIndex={stageProgress}
        stageLabel={stageLabel}
        title={title}
      />
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
      const downloadUrl = artifact
        ? resolveArtifactDownloadUrl({ artifact, workspaceId })
        : null;
      return {
        artifact,
        downloadUrl,
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
      {imageItems.map(({ artifact, downloadUrl, imageUrl, toolCall }) => {
        const title =
          artifact?.title ||
          getGeneratedImageTitle(toolCall) ||
          "Generated image";
        const imageStatus = getGeneratedImageStatus(toolCall);
        const stageLabel = imageStatus.label ?? "Rendering";

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

        return (
          <GeneratedImageArtifactItem
            aspectRatio={imageStatus.aspectRatio}
            downloadUrl={downloadUrl ?? imageUrl}
            imageUrl={imageUrl}
            key={toolCall.id}
            stageLabel={stageLabel}
            stageProgress={imageStatus.progress ?? null}
            status={toolCall.status}
            title={title}
          />
        );
      })}
    </div>
  );
}

export function GeneratedImageArtifactBlock({
  toolCall,
  workspaceId,
}: {
  toolCall: ToolCallRecord | undefined;
  workspaceId?: string | null;
}) {
  return (
    <GeneratedImageArtifacts
      toolCalls={toolCall ? [toolCall] : []}
      workspaceId={workspaceId}
    />
  );
}

function formatThoughtDuration(durationMs: number | undefined) {
  if (durationMs === undefined) {
    return "Thought for a few seconds";
  }

  const duration = Math.max(1, Math.ceil(durationMs / 1000));
  return `Thought for ${duration} ${duration === 1 ? "second" : "seconds"}`;
}

function getReasoningTraceTitle(input: {
  activeStep?: ThinkingStepRecord;
  duration?: number;
  hasModelReasoning: boolean;
  isCancelled?: boolean;
  isStreaming: boolean;
  latestDisplayStep?: ThinkingStepRecord;
  reasoningDurationMs?: number;
}) {
  if (input.isCancelled) {
    return formatThoughtDuration(input.reasoningDurationMs ?? input.duration);
  }

  if (input.activeStep) {
    return `Thinking · ${input.activeStep.title}`;
  }

  if (input.isStreaming) {
    if (input.hasModelReasoning) {
      return "Thinking · Chat model reasoning";
    }

    if (
      input.latestDisplayStep &&
      input.latestDisplayStep.status !== "completed" &&
      !isVisionFallbackStep(input.latestDisplayStep)
    ) {
      return input.latestDisplayStep.title;
    }

    return "Thinking...";
  }

  if (input.hasModelReasoning) {
    return formatThoughtDuration(input.reasoningDurationMs ?? input.duration);
  }

  return "Thinking...";
}

export function ReasoningTrace({
  isCancelled = false,
  isStreaming,
  modelReasoning,
  modelReasoningSegments,
  onArtifactPreview,
  steps,
  toolCalls,
  workspaceId,
}: {
  isCancelled?: boolean;
  isStreaming: boolean;
  modelReasoning?: string;
  modelReasoningSegments?: ModelReasoningSegmentRecord[];
  onArtifactPreview?: (artifact: ArtifactPreviewRecord) => void;
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
  const activeStep = isCancelled
    ? undefined
    : safeSteps.find((step) => step.status === "in_progress");
  const latestDisplayStep = displaySteps
    .map((step, index) => ({ index, step }))
    .sort((left, right) => {
      const sequenceDelta =
        (left.step.sequence ?? left.index) - (right.step.sequence ?? right.index);
      return sequenceDelta === 0 ? left.index - right.index : sequenceDelta;
    })
    .at(-1)?.step;
  const hasRunningToolCall =
    !isCancelled &&
    safeToolCalls.some((toolCall) => toolCall.status === "running");
  const isThinking =
    !isCancelled && (isStreaming || Boolean(activeStep) || hasRunningToolCall);
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

  useEffect(() => {
    if (activeStep) {
      setIsOpen(true);
    }
  }, [activeStep?.id, activeStep?.status, activeStep?.title]);

  if (!hasTraceItems && !isStreaming) {
    return null;
  }

  const title = getReasoningTraceTitle({
    activeStep,
    duration,
    hasModelReasoning,
    isCancelled,
    isStreaming,
    latestDisplayStep,
    reasoningDurationMs,
  });

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
        <span className="block min-w-0 truncate">
          <span className="truncate">
            {isThinking ? <Shimmer duration={1}>{title}</Shimmer> : title}
          </span>
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
                  label="Chat model reasoning"
                  status={isStreaming && !isCancelled ? "active" : "complete"}
                >
                  <div className="whitespace-pre-wrap break-words text-muted-foreground text-xs leading-5">
                    {item.text}
                  </div>
                </ChainOfThoughtStep>
              );
            }

            if (item.kind === "step") {
              const { step } = item;
              const isVisionFallback = isVisionFallbackStep(step);
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
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 font-medium text-[11px]",
                        isCancelled
                          ? "bg-muted text-muted-foreground"
                          : "bg-primary/10 text-primary",
                      )}
                    >
                      {isCancelled ? "Stopped" : "Running"}
                    </span>
                  ) : null}
                </span>
              );
              const stepStatus =
                step.status === "in_progress"
                  ? isCancelled
                    ? "pending"
                    : "active"
                  : step.status === "pending"
                    ? "pending"
                    : "complete";
              return (
                <ChainOfThoughtStep
                  icon={isVisionFallback ? ImageIcon : undefined}
                  key={item.key}
                  label={stepLabel}
                  status={stepStatus}
                >
                  {step.detail ? (
                    <p className="text-muted-foreground text-xs leading-5">
                      {step.detail}
                    </p>
                  ) : null}
                  {isVisionFallback ? (
                    <VisionFallbackStepDetails step={step} />
                  ) : step.items.length > 0 ? (
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
            const toolStatus =
              toolCall.status === "running"
                ? isCancelled
                  ? "pending"
                  : "active"
                : toolCall.status === "error"
                  ? "pending"
                  : "complete";
            return (
              <ChainOfThoughtStep
                description={summary}
                icon={WrenchIcon}
                key={item.key}
                label={getToolDisplayLabel(toolCall)}
                status={toolStatus}
              >
                <ToolCallDetails
                  onArtifactPreview={onArtifactPreview}
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
