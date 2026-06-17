import {
  HumanMessage,
  RemoveMessage,
  type MessageContent,
} from "@langchain/core/messages";
import { REMOVE_ALL_MESSAGES } from "@langchain/langgraph";
import { createMiddleware } from "langchain";

function imageBlockToHistoryText(
  block: Record<string, unknown>,
  index: number,
) {
  const url =
    typeof block.url === "string"
      ? block.url
      : typeof block.image_url === "string"
        ? block.image_url
        : typeof (block.image_url as { url?: unknown } | undefined)?.url ===
            "string"
          ? (block.image_url as { url: string }).url
          : "";
  const mimeType =
    typeof block.mimeType === "string"
      ? block.mimeType
      : typeof block.mime_type === "string"
        ? block.mime_type
        : "image";
  const isDataUrl = url.startsWith("data:");
  return `[attached image ${index + 1}: ${mimeType}${isDataUrl ? ", omitted from conversation history" : ""}]`;
}

function sanitizeMessageContentForHistory(content: unknown) {
  if (!Array.isArray(content)) {
    return { content, changed: false };
  }

  let imageIndex = 0;
  let changed = false;
  const next = content.map((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      return part;
    }
    const record = part as Record<string, unknown>;
    if (record.type !== "image" && record.type !== "image_url") {
      return part;
    }
    changed = true;
    const text = imageBlockToHistoryText(record, imageIndex);
    imageIndex += 1;
    return { type: "text", text };
  });

  return { content: next, changed };
}

export function sanitizeMessagesForHistory(messages: unknown) {
  if (!Array.isArray(messages)) {
    return { messages: [], changed: false };
  }

  let changed = false;
  const sanitized = messages.map((message) => {
    if (!HumanMessage.isInstance(message)) {
      return message;
    }
    const nextContent = sanitizeMessageContentForHistory(message.content);
    if (!nextContent.changed) {
      return message;
    }
    changed = true;
    return new HumanMessage({
      content: nextContent.content as MessageContent,
      id: message.id,
      name: message.name,
      additional_kwargs: message.additional_kwargs,
      response_metadata: message.response_metadata,
    });
  });

  return { messages: sanitized, changed };
}

export function createSourceWeftImageHistorySanitizerMiddleware() {
  return createMiddleware({
    name: "SourceWeftImageHistorySanitizer",
    afterAgent: async (state) => {
      const result = sanitizeMessagesForHistory(state.messages);
      if (!result.changed) {
        return;
      }
      return {
        messages: [
          new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
          ...result.messages,
        ],
      };
    },
  });
}
