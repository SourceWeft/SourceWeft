import { isGeneratedImageArtifactToolName } from "@sourceweft/sdk";
import { apiBaseUrl } from "../../../../../lib/sdk";
import type {
  ChatMessageImagePart,
  MessageRenderBlock,
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
    if (!isGeneratedImageArtifactToolName(toolCall.tool)) {
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

function matchGeneratedImageToolCall(input: {
  artifactIds: Set<string>;
  artifactUrls: Set<string>;
  toolCalls?: ToolCallRecord[];
  url: string;
}) {
  const normalizedUrl = normalizeAssetUrl(input.url);
  const artifactId = extractArtifactIdFromUrl(input.url);

  return (
    (input.toolCalls ?? []).find((toolCall) => {
      if (!isGeneratedImageArtifactToolName(toolCall.tool)) {
        return false;
      }

      const artifact = resolveGeneratedImageArtifact(toolCall);
      if (!artifact) {
        return false;
      }

      if (artifactId && input.artifactIds.has(artifactId)) {
        const toolArtifactId = artifact.artifactId;
        if (toolArtifactId && toolArtifactId === artifactId) {
          return true;
        }
      }

      const candidateUrls = [
        artifact.artifactUrl,
        resolveArtifactUrl({ artifact, workspaceId: null }),
      ]
        .filter((value): value is string => Boolean(value))
        .map((value) => normalizeAssetUrl(value));

      return (
        candidateUrls.includes(normalizedUrl) ||
        (artifactId ? candidateUrls.some((value) => extractArtifactIdFromUrl(value) === artifactId) : false)
      );
    }) ?? null
  );
}

export function buildRenderBlocksFromMessageContent(input: {
  content: string;
  toolCalls?: ToolCallRecord[];
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
    return null;
  }

  const blocks: MessageRenderBlock[] = [];
  const seenToolCallIds = new Set<string>();
  const imageMarkdownPattern = /!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let nextTextId = 1;
  let lastIndex = 0;

  for (const match of input.content.matchAll(imageMarkdownPattern)) {
    const fullMatch = match[0];
    const rawUrl = match[1];
    const matchIndex = match.index ?? -1;
    if (!fullMatch || !rawUrl || matchIndex < 0) {
      continue;
    }

    const toolCall = matchGeneratedImageToolCall({
      artifactIds: artifactRefs.artifactIds,
      artifactUrls: artifactRefs.artifactUrls,
      toolCalls: input.toolCalls,
      url: rawUrl,
    });
    if (!toolCall) {
      continue;
    }

    const textBefore = input.content.slice(lastIndex, matchIndex);
    if (textBefore) {
      blocks.push({
        id: `fallback-text-${nextTextId}`,
        type: "text",
        text: textBefore,
      });
      nextTextId += 1;
    }

    if (!seenToolCallIds.has(toolCall.id)) {
      blocks.push({
        id: `fallback-generated-image-${toolCall.id}`,
        type: "generated_image",
        toolCallId: toolCall.id,
      });
      seenToolCallIds.add(toolCall.id);
    }

    lastIndex = matchIndex + fullMatch.length;
  }

  if (blocks.length === 0) {
    return null;
  }

  const trailingText = input.content.slice(lastIndex);
  if (trailingText) {
    blocks.push({
      id: `fallback-text-${nextTextId}`,
      type: "text",
      text: trailingText,
    });
  }

  return blocks;
}

export function getMessageImageParts(version: MessageVersion) {
  const parts = version.contentJson?.parts;
  if (!Array.isArray(parts)) {
    return [] as ChatMessageImagePart[];
  }

  return parts.filter(
    (part): part is ChatMessageImagePart =>
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
  return value.startsWith("/v1/") ? `${apiBaseUrl}${value}` : value;
}

export function resolveMessageAssetUrl(value: unknown) {
  if (typeof value !== "string") {
    return value;
  }

  return normalizeAssetUrl(value);
}

function getToolOutputField(output: unknown, key: string) {
  if (typeof output === "object" && output !== null) {
    const direct = (output as Record<string, unknown>)[key];
    if (typeof direct === "string" && direct.trim().length > 0) {
      return direct.trim();
    }

    const content = getToolOutputContent(output);
    if (content) {
      const match = content.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
      return match?.[1]?.trim() ?? null;
    }

    return null;
  }

  if (typeof output !== "string") {
    return null;
  }

  const match = output.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}

export function resolveGeneratedImageArtifact(
  toolCall: ToolCallRecord,
  toolStep?: ThinkingStepRecord,
): GeneratedImageArtifact | null {
  if (!isGeneratedImageArtifactToolName(toolCall.tool)) {
    return null;
  }

  const metadata = toolStep?.metadata;
  const artifactId =
    (typeof metadata?.artifactId === "string"
      ? metadata.artifactId.trim()
      : "") || getToolOutputField(toolCall.output, "artifact_id");
  const artifactUrl =
    (typeof metadata?.artifactUrl === "string"
      ? metadata.artifactUrl.trim()
      : "") ||
    getToolOutputField(toolCall.output, "artifact_url") ||
    getToolOutputField(toolCall.output, "preview_url");
  const title = getToolOutputField(toolCall.output, "title");

  if (!artifactId && !artifactUrl) {
    return null;
  }

  return {
    artifactId: artifactId || null,
    artifactUrl: artifactUrl || null,
    title,
  };
}

export function resolveArtifactUrl(input: {
  artifact: GeneratedImageArtifact;
  workspaceId?: string | null;
}) {
  if (input.workspaceId && input.artifact.artifactId) {
    return `${apiBaseUrl}/v1/workspaces/${encodeURIComponent(input.workspaceId)}/artifacts/${encodeURIComponent(input.artifact.artifactId)}/file`;
  }

  if (input.artifact.artifactUrl) {
    return input.artifact.artifactUrl.startsWith("http")
      ? input.artifact.artifactUrl
      : `${apiBaseUrl}${input.artifact.artifactUrl}`;
  }

  return null;
}

export function resolveArtifactDownloadUrl(input: {
  artifact: GeneratedImageArtifact;
  workspaceId?: string | null;
}) {
  if (!input.workspaceId || !input.artifact.artifactId) {
    return null;
  }

  return `${apiBaseUrl}/v1/workspaces/${encodeURIComponent(input.workspaceId)}/artifacts/${encodeURIComponent(input.artifact.artifactId)}/download`;
}

export function getToolOutputContent(output: unknown) {
  if (output === null || output === undefined) {
    return null;
  }

  if (typeof output === "string") {
    return output;
  }

  if (typeof output === "object") {
    const record = output as Record<string, unknown>;
    if (typeof record.displayContent === "string") {
      return record.displayContent;
    }
    if (typeof record.content === "string") {
      return record.content;
    }
    return null;
  }

  return String(output);
}
