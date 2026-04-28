import type { UsageInfo } from "@sourceweft/model-gateway";

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readNumber(record: Record<string, unknown> | null, key: string) {
  return record ? asNumber(record[key]) : undefined;
}

export function extractTextDeltas(content: unknown): string[] {
  if (typeof content === "string") {
    return content.length > 0 ? [content] : [];
  }

  if (Array.isArray(content)) {
    return content
      .flatMap((part) => extractTextDeltas(part))
      .filter((part) => part.length > 0);
  }

  if (!content || typeof content !== "object") {
    return [];
  }

  const record = content as Record<string, unknown>;
  if (typeof record.text === "string" && record.text.length > 0) {
    return [record.text];
  }

  if (typeof record.content === "string" && record.content.length > 0) {
    return [record.content];
  }

  if (record.content !== undefined) {
    return extractTextDeltas(record.content);
  }

  if (record.delta !== undefined) {
    return extractTextDeltas(record.delta);
  }

  return [];
}

export function sanitizeSseValue(value: string) {
  return value.replace(/\u0000/g, "");
}

export function stringifyAgentMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .flatMap((part) => extractTextDeltas(part))
      .join("\n")
      .trim();
  }

  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (typeof record.content === "string") {
      return record.content;
    }
  }

  return "";
}

export function toObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function extractUsageFromMessageChunk(chunk: unknown): UsageInfo | undefined {
  const record = toObjectRecord(chunk);
  if (!record) {
    return undefined;
  }

  const responseMetadata = toObjectRecord(record.response_metadata);
  const usageSource =
    toObjectRecord(record.usage_metadata) ??
    toObjectRecord(responseMetadata?.usage) ??
    toObjectRecord(responseMetadata?.tokenUsage);
  if (!usageSource) {
    return undefined;
  }

  const promptDetails =
    toObjectRecord(usageSource.prompt_tokens_details) ??
    toObjectRecord(usageSource.input_tokens_details);
  return {
    inputTokens:
      readNumber(usageSource, "prompt_tokens") ??
      readNumber(usageSource, "input_tokens"),
    outputTokens:
      readNumber(usageSource, "completion_tokens") ??
      readNumber(usageSource, "output_tokens"),
    totalTokens: readNumber(usageSource, "total_tokens"),
    cacheReadTokens: readNumber(promptDetails, "cached_tokens"),
    cacheWriteTokens:
      readNumber(promptDetails, "cache_write_tokens") ??
      readNumber(promptDetails, "cache_creation_tokens"),
  };
}

export function extractFinishReasonFromMessageChunk(chunk: unknown) {
  const record = toObjectRecord(chunk);
  const responseMetadata = toObjectRecord(record?.response_metadata);
  return (
    (typeof responseMetadata?.finish_reason === "string"
      ? responseMetadata.finish_reason
      : undefined) ??
    (typeof responseMetadata?.finishReason === "string"
      ? responseMetadata.finishReason
      : undefined)
  );
}

export function extractProviderFieldsFromMessageChunk(chunk: unknown) {
  const record = toObjectRecord(chunk);
  return toObjectRecord(record?.response_metadata) ?? undefined;
}

export function extractTextDeltasFromMessageChunk(chunk: unknown): string[] {
  const record = toObjectRecord(chunk);
  if (!record) {
    return extractTextDeltas(chunk);
  }

  const role = typeof record.role === "string" ? record.role : "";
  const type = typeof record.type === "string" ? record.type : "";
  const messageType =
    typeof record._getType === "function"
      ? String(record._getType())
      : typeof record.getType === "function"
        ? String(record.getType())
        : "";
  const constructorName =
    typeof record.constructor === "function" &&
    typeof record.constructor.name === "string"
      ? record.constructor.name
      : "";
  const isAssistant =
    role === "assistant" ||
    role === "ai" ||
    type === "assistant" ||
    type === "ai" ||
    type === "AIMessageChunk" ||
    messageType === "assistant" ||
    messageType === "ai" ||
    constructorName === "AIMessageChunk" ||
    constructorName === "AIMessage";

  if (!isAssistant) {
    return [];
  }

  const contentBlocks = Array.isArray(record.contentBlocks)
    ? record.contentBlocks
    : Array.isArray(record.content_blocks)
      ? (record.content_blocks as unknown[])
      : null;

  if (contentBlocks) {
    return contentBlocks
      .flatMap((block) => {
        if (!block || typeof block !== "object") {
          return [] as string[];
        }
        const part = block as Record<string, unknown>;
        if (typeof part.text === "string") {
          return [part.text];
        }
        if (typeof part.content === "string") {
          return [part.content];
        }
        return [] as string[];
      })
      .filter((part) => part.length > 0);
  }

  return extractTextDeltas(record.content);
}

export function resolveAssistantContentFromUpdatesChunk(
  chunk: unknown,
): string | null {
  const updates = toObjectRecord(chunk);
  if (!updates) {
    return null;
  }

  for (const value of Object.values(updates)) {
    const update = toObjectRecord(value);
    if (!update) {
      continue;
    }

    const messages = Array.isArray(update.messages) ? update.messages : null;
    if (!messages) {
      continue;
    }

    for (const message of messages) {
      if (!message || typeof message !== "object") {
        continue;
      }
      const record = message as Record<string, unknown>;
      const role = typeof record.role === "string" ? record.role : "";
      const type = typeof record.type === "string" ? record.type : "";
      const isAssistant =
        role === "assistant" ||
        role === "ai" ||
        type === "assistant" ||
        type === "ai";
      if (!isAssistant) {
        continue;
      }
      const content = stringifyAgentMessageContent(record.content);
      if (content.trim().length > 0) {
        return content.trim();
      }
    }
  }

  return null;
}
