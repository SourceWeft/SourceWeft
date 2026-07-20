import {
  hasAgentToolCapability,
  isArtifactProgressOutputType,
} from "@sourceweft/agent-tool-registry";
import { resolveGeneratedImageArtifactRef } from "@sourceweft/agent-tool-registry/ui";
import {
  normalizeWebAssetUrl,
  resolveArtifactPageUrlFromArtifact,
  resolveArtifactProxyFileUrlFromArtifact,
} from "../artifact-urls";
import type {
  ChatMessageImagePart,
  MessageVersion,
  ThinkingStepRecord,
  ToolCallRecord,
} from "./types";

const TOOL_ONLY_EMPTY_RESPONSE_TEXT = "Model returned an empty response.";

export type GeneratedImageArtifact = {
  artifactId: string | null;
  artifactUrl: string | null;
  title: string | null;
};

function extractArtifactIdFromUrl(value: string) {
  const match = value.match(/\/artifacts\/([^/?#]+)\/file(?:[?#].*)?$/);
  return match ? decodeURIComponent(match[1] ?? "") : null;
}

function getGeneratedImageArtifactRefs(input: {
  toolCalls?: ToolCallRecord[];
  workspaceId?: string | null;
}) {
  const artifactIds = new Set<string>();
  const artifactUrls = new Set<string>();

  for (const toolCall of input.toolCalls ?? []) {
    if (!hasAgentToolCapability(toolCall.tool, "generated_image_artifact")) {
      continue;
    }

    const artifact = resolveGeneratedImageArtifact(toolCall);
    if (!artifact) {
      continue;
    }

    if (artifact.artifactId) {
      artifactIds.add(artifact.artifactId);
    }

    const urls = [
      artifact.artifactUrl,
      resolveArtifactUrl({ artifact, workspaceId: input.workspaceId }),
    ];
    for (const url of urls) {
      if (!url) {
        continue;
      }
      artifactUrls.add(normalizeAssetUrl(url));
      const artifactId = extractArtifactIdFromUrl(url);
      if (artifactId) {
        artifactIds.add(artifactId);
      }
    }
  }

  return { artifactIds, artifactUrls };
}

export function stripGeneratedImageMarkdown(input: {
  content: string;
  toolCalls?: ToolCallRecord[];
  trim?: boolean;
  workspaceId?: string | null;
}) {
  const artifactRefs = getGeneratedImageArtifactRefs({
    toolCalls: input.toolCalls,
    workspaceId: input.workspaceId,
  });

  if (
    artifactRefs.artifactIds.size === 0 &&
    artifactRefs.artifactUrls.size === 0
  ) {
    return input.content;
  }

  const content = input.content
    .replace(
      /!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
      (markdown: string, url: string) => {
        const rawUrl = String(url).trim();
        const normalizedUrl = normalizeAssetUrl(rawUrl);
        const artifactId = extractArtifactIdFromUrl(rawUrl);
        const isGeneratedImage =
          artifactRefs.artifactUrls.has(normalizedUrl) ||
          (artifactId ? artifactRefs.artifactIds.has(artifactId) : false);
        return isGeneratedImage ? "" : markdown;
      },
    )
    .replace(/\n{3,}/g, "\n\n");

  return input.trim === false ? content : content.trim();
}

export function getMessageText(input: {
  version: MessageVersion;
  workspaceId?: string | null;
}): string {
  const text = stripGeneratedImageMarkdown({
    content: input.version.content,
    toolCalls: input.version.toolCalls,
    workspaceId: input.workspaceId,
  });
  return text.trim() === TOOL_ONLY_EMPTY_RESPONSE_TEXT &&
    (input.version.toolCalls?.length ?? 0) > 0
    ? ""
    : text;
}

export function getMessageImageParts(version: MessageVersion) {
  const parts = version.contentJson?.parts;
  if (!Array.isArray(parts)) {
    return [] as ChatMessageImagePart[];
  }

  return parts.filter(
    (part): part is ChatMessageImagePart =>
      typeof part === "object" &&
      part !== null &&
      part.type === "image" &&
      typeof part.id === "string" &&
      typeof part.url === "string" &&
      typeof part.fileName === "string",
  );
}

export function compactText(value: string, maxLength = 160) {
  const compacted = value.replace(/\s+/g, " ").trim();
  return compacted.length > maxLength
    ? `${compacted.slice(0, maxLength - 1)}…`
    : compacted;
}

export function normalizeAssetUrl(value: string) {
  return normalizeWebAssetUrl(value);
}

export function resolveMessageAssetUrl(value: unknown) {
  if (typeof value !== "string") {
    return value;
  }

  return normalizeAssetUrl(value);
}

function readRawToolOutputContent(output: unknown) {
  if (output === null || output === undefined) {
    return null;
  }
  if (typeof output === "string") {
    return output;
  }
  if (typeof output === "object" && !Array.isArray(output)) {
    const record = output as Record<string, unknown>;
    if (typeof record.displayContent === "string") {
      return record.displayContent;
    }
    if (typeof record.content === "string") {
      return record.content;
    }
  }
  return null;
}

function getToolOutputRecordFromContent(output: unknown) {
  const content = readRawToolOutputContent(output);
  if (!content) {
    return null;
  }

  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Structured progress outputs are rendered as a progress card rather than as
 * raw text. Which `type` values qualify comes from the capability packages via
 * the registry — adding a deliverable must not require editing this file.
 */
export function isArtifactProgressToolOutputType(
  type: string | null | undefined,
) {
  return isArtifactProgressOutputType(type);
}

export function parseStructuredToolOutputRecord(
  output: unknown,
): Record<string, unknown> | null {
  const fromContent = getToolOutputRecordFromContent(output);
  if (
    fromContent &&
    isArtifactProgressToolOutputType(
      typeof fromContent.type === "string" ? fromContent.type : null,
    )
  ) {
    return fromContent;
  }

  if (output && typeof output === "object" && !Array.isArray(output)) {
    const record = output as Record<string, unknown>;
    if (typeof record.type === "string") {
      return record;
    }
    if (fromContent && typeof fromContent.type === "string") {
      return fromContent;
    }
    return record;
  }

  if (typeof output === "string") {
    return fromContent;
  }

  return fromContent;
}

export function normalizeVideoPresentationToolOutput(output: unknown) {
  const record = parseStructuredToolOutputRecord(output);
  const type = typeof record?.type === "string" ? record.type : null;
  if (!record || !isArtifactProgressToolOutputType(type)) {
    return output;
  }
  return record;
}

/**
 * The raw value behind an output key. Exported as a host facility so capability
 * UI can read its own non-string scalars without re-implementing the transport
 * walk; `getToolOutputField` is the same lookup, stringified.
 */
export function getToolOutputValue(output: unknown, key: string) {
  const contentRecord = getToolOutputRecordFromContent(output);
  const preferContent =
    contentRecord !== null &&
    isArtifactProgressToolOutputType(
      typeof contentRecord.type === "string" ? contentRecord.type : null,
    );

  if (preferContent && contentRecord[key] !== undefined) {
    return contentRecord[key];
  }

  if (typeof output === "object" && output !== null) {
    const direct = (output as Record<string, unknown>)[key];
    if (direct !== undefined && direct !== null) {
      return direct;
    }

    if (contentRecord && contentRecord[key] !== undefined) {
      return contentRecord[key];
    }

    return null;
  }

  if (contentRecord && contentRecord[key] !== undefined) {
    return contentRecord[key];
  }

  return null;
}

export function getToolOutputField(output: unknown, key: string) {
  const value = getToolOutputValue(output, key);
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof output !== "string") {
    const content = getToolOutputContent(output);
    if (!content) {
      return null;
    }
    const match = content.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return match?.[1]?.trim() ?? null;
  }

  const match = output.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}

export function resolveGeneratedImageArtifact(
  toolCall: ToolCallRecord,
  toolStep?: ThinkingStepRecord,
): GeneratedImageArtifact | null {
  if (!hasAgentToolCapability(toolCall.tool, "generated_image_artifact")) {
    return null;
  }

  // Which output keys carry the artifact reference is the image capability's
  // business; this layer only supplies the transport-level field reader.
  return resolveGeneratedImageArtifactRef({
    metadata: toolStep?.metadata,
    readField: (key) => getToolOutputField(toolCall.output, key),
  });
}

export function resolveArtifactUrl(input: {
  artifact: GeneratedImageArtifact;
  workspaceId?: string | null;
}) {
  return resolveArtifactPageUrlFromArtifact({
    artifactId: input.artifact.artifactId,
    fallbackUrl: input.artifact.artifactUrl,
    workspaceId: input.workspaceId,
  });
}

export function resolveArtifactFileUrl(input: {
  artifact: Pick<GeneratedImageArtifact, "artifactId"> & {
    artifactUrl?: string | null;
  };
  workspaceId?: string | null;
}) {
  return resolveArtifactProxyFileUrlFromArtifact({
    artifactId: input.artifact.artifactId,
    fallbackUrl: input.artifact.artifactUrl,
    workspaceId: input.workspaceId,
  });
}

export function resolveArtifactDownloadUrl(input: {
  artifact: Pick<GeneratedImageArtifact, "artifactId"> & {
    artifactUrl?: string | null;
  };
  workspaceId?: string | null;
}) {
  return resolveArtifactProxyFileUrlFromArtifact({
    artifactId: input.artifact.artifactId,
    download: true,
    fallbackUrl: input.artifact.artifactUrl,
    workspaceId: input.workspaceId,
  });
}

export function getToolOutputContent(output: unknown) {
  if (output === null || output === undefined) {
    return null;
  }

  const structured = parseStructuredToolOutputRecord(output);
  if (
    structured &&
    isArtifactProgressToolOutputType(
      typeof structured.type === "string" ? structured.type : undefined,
    )
  ) {
    if (
      typeof structured.content === "string" &&
      !structured.content.trim().startsWith("{")
    ) {
      return structured.content;
    }
    return null;
  }

  return readRawToolOutputContent(output);
}
