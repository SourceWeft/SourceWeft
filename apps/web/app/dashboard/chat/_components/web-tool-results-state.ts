import { isAgentToolDomain } from "@sourceweft/agent-tool-registry";
import type {
  MessageVersion,
  ToolCallRecord,
} from "./chat-canvas";

export type WebPageToolResult = {
  url: string;
  title?: string;
  rank?: number;
  citation?: string;
  wordCount?: number;
  error?: string;
  truncated?: boolean;
  hasContent?: boolean;
};

function toObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getFetchInputUrls(toolCall: ToolCallRecord) {
  const items = toolCall.input.items;
  if (!Array.isArray(items)) {
    return [] as string[];
  }

  return items
    .map((item) => {
      const record = toObjectRecord(item);
      const url = typeof record?.url === "string" ? record.url.trim() : "";
      return url || null;
    })
    .filter((url): url is string => url !== null);
}

export function getWebPageToolResults(
  toolCall: ToolCallRecord,
): WebPageToolResult[] {
  const outputRecord = toObjectRecord(toolCall.output);
  const pages = outputRecord?.pages;
  if (Array.isArray(pages)) {
    return pages
      .map((item): WebPageToolResult | null => {
        const record = toObjectRecord(item);
        const url = typeof record?.url === "string" ? record.url.trim() : "";
        if (!url) {
          return null;
        }
        const title =
          typeof record?.title === "string" && record.title.trim()
            ? record.title.trim()
            : undefined;
        const rank =
          typeof record?.rank === "number" && Number.isFinite(record.rank)
            ? record.rank
            : undefined;
        const citation =
          typeof record?.citation === "string" && record.citation.trim()
            ? record.citation.trim()
            : undefined;
        const wordCount =
          typeof record?.wordCount === "number" &&
          Number.isFinite(record.wordCount)
            ? record.wordCount
            : undefined;
        const error =
          typeof record?.error === "string" && record.error.trim()
            ? record.error.trim()
            : undefined;
        return {
          url,
          ...(title ? { title } : {}),
          ...(rank !== undefined ? { rank } : {}),
          ...(citation ? { citation } : {}),
          ...(wordCount !== undefined ? { wordCount } : {}),
          ...(error ? { error } : {}),
          ...(record?.truncated === true ? { truncated: true } : {}),
          ...(record?.hasContent === true ? { hasContent: true } : {}),
        };
      })
      .filter((item): item is WebPageToolResult => item !== null);
  }

  return getFetchInputUrls(toolCall).map((url, index) => ({
    url,
    rank: index + 1,
  }));
}

export function hasWebPageToolResults(
  toolCalls: ToolCallRecord[] | undefined,
) {
  return (toolCalls ?? []).some(
    (toolCall) =>
      isAgentToolDomain(toolCall.tool, "web") &&
      getWebPageToolResults(toolCall).length > 0,
  );
}

export function getWebPageToolCallIds(
  toolCalls: ToolCallRecord[] | undefined,
) {
  return (toolCalls ?? [])
    .filter(
      (toolCall) =>
        isAgentToolDomain(toolCall.tool, "web") &&
        getWebPageToolResults(toolCall).length > 0,
    )
    .map((toolCall) => toolCall.id);
}

export function shouldRenderWebToolResultsFallback(input: {
  attachedToolCallIds: Iterable<string>;
  toolCalls: ToolCallRecord[] | undefined;
}) {
  const attachedIds = new Set(input.attachedToolCallIds);
  return getWebPageToolCallIds(input.toolCalls).some(
    (toolCallId) => !attachedIds.has(toolCallId),
  );
}

export function getAttachedWebToolCallIds(input: {
  renderBlocks?: MessageVersion["renderBlocks"];
  toolCalls?: MessageVersion["toolCalls"];
}) {
  const webToolCallIds = new Set(getWebPageToolCallIds(input.toolCalls));
  const attachedIds = new Set<string>();

  for (const block of input.renderBlocks ?? []) {
    if (block.type !== "tool") {
      continue;
    }
    if (webToolCallIds.has(block.toolCallId)) {
      attachedIds.add(block.toolCallId);
    }
  }

  return attachedIds;
}
