import { toObjectRecord } from "../../../../shared/records";
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

function normalizeMessageKind(value: unknown) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

export function isAssistantMessageLike(message: unknown): boolean {
  const record = toObjectRecord(message);
  if (!record) {
    return false;
  }

  const role = normalizeMessageKind(record.role);
  const type = normalizeMessageKind(record.type);
  const getTypeValue =
    typeof record._getType === "function"
      ? normalizeMessageKind(record._getType())
      : typeof record.getType === "function"
        ? normalizeMessageKind(record.getType())
        : "";
  const constructorName = normalizeMessageKind(
    typeof record.constructor === "function" ? record.constructor.name : "",
  );

  return [role, type, getTypeValue, constructorName].some(
    (kind) =>
      kind === "assistant" ||
      kind === "ai" ||
      kind === "aimessage" ||
      kind === "aimessagechunk",
  );
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

export function extractReasoningFromProviderFields(
  providerFields: Record<string, unknown> | undefined,
) {
  if (!providerFields) {
    return undefined;
  }

  const candidates = [
    providerFields.reasoning_content,
    providerFields.reasoningContent,
    providerFields.reasoning,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }

    const record = toObjectRecord(candidate);
    if (!record) {
      continue;
    }

    const content =
      typeof record.content === "string"
        ? record.content
        : typeof record.text === "string"
          ? record.text
          : null;
    if (content && content.trim().length > 0) {
      return content;
    }
  }

  return undefined;
}

function extractReasoningFromOpenRouterDetail(detail: unknown): string | null {
  const record = toObjectRecord(detail);
  if (!record) {
    return null;
  }

  const type = typeof record.type === "string" ? record.type : "";
  if (type === "reasoning.text" && typeof record.text === "string") {
    return record.text.trim().length > 0 ? record.text : null;
  }
  if (type === "reasoning.summary" && typeof record.summary === "string") {
    return record.summary.trim().length > 0 ? record.summary : null;
  }
  if (typeof record.text === "string" && record.text.trim().length > 0) {
    return record.text;
  }
  if (typeof record.summary === "string" && record.summary.trim().length > 0) {
    return record.summary;
  }
  return null;
}

function extractReasoningFromOpenRouterDetails(
  value: unknown,
): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const reasoning = value
    .map(extractReasoningFromOpenRouterDetail)
    .filter((item): item is string => item !== null)
    .join("\n\n");

  return reasoning.trim().length > 0 ? reasoning : undefined;
}

function extractReasoningFromContentBlock(block: unknown): string | null {
  const blockRecord = toObjectRecord(block);
  if (!blockRecord) {
    return null;
  }

  const blockType =
    typeof blockRecord.type === "string" ? blockRecord.type.toLowerCase() : "";
  if (!blockType.includes("reasoning") && !blockType.includes("thinking")) {
    return null;
  }

  const text =
    typeof blockRecord.reasoning === "string"
      ? blockRecord.reasoning
      : typeof blockRecord.text === "string"
        ? blockRecord.text
        : typeof blockRecord.content === "string"
          ? blockRecord.content
          : null;
  return text && text.trim().length > 0 ? text : null;
}

function extractReasoningFromContentBlocks(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const reasoning = value
    .map(extractReasoningFromContentBlock)
    .filter((item): item is string => item !== null)
    .join("\n\n");

  return reasoning.trim().length > 0 ? reasoning : undefined;
}

function extractReasoningDeep(value: unknown, depth = 0): string | undefined {
  if (depth > 8) {
    return undefined;
  }

  if (Array.isArray(value)) {
    const directBlocks = extractReasoningFromContentBlocks(value);
    if (directBlocks) {
      return directBlocks;
    }

    for (const item of value) {
      const nested = extractReasoningDeep(item, depth + 1);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  }

  const record = toObjectRecord(value);
  if (!record) {
    return undefined;
  }

  const direct = extractReasoningFromProviderFields(record);
  if (direct) {
    return direct;
  }

  const details = extractReasoningFromOpenRouterDetails(
    record.reasoning_details,
  );
  if (details) {
    return details;
  }

  const directBlock = extractReasoningFromContentBlock(record);
  if (directBlock) {
    return directBlock;
  }

  const prioritizedKeys = [
    "contentBlocks",
    "content_blocks",
    "__raw_response",
    "choices",
    "delta",
    "chunk",
    "message",
    "metadata",
    "ls_provider",
    "additional_kwargs",
    "kwargs",
    "response_metadata",
    "content",
  ];
  for (const key of prioritizedKeys) {
    const nested = extractReasoningDeep(record[key], depth + 1);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

export function extractReasoningFromMessageChunk(chunk: unknown) {
  return extractReasoningDeep(chunk);
}

export function extractTextDeltasFromMessageChunk(chunk: unknown): string[] {
  const record = toObjectRecord(chunk);
  if (!record) {
    return extractTextDeltas(chunk);
  }

  if (!isAssistantMessageLike(record)) {
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
        const partType =
          typeof part.type === "string" ? part.type.toLowerCase() : "";
        if (partType.includes("reasoning") || partType.includes("thinking")) {
          return [] as string[];
        }
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
      if (!isAssistantMessageLike(message)) {
        continue;
      }
      const record = message as Record<string, unknown>;
      const content = stringifyAgentMessageContent(record.content);
      if (content.trim().length > 0) {
        return content.trim();
      }
    }
  }

  return null;
}
