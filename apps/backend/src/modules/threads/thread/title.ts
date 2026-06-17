import type { ChatCompleteResult } from "@sourceweft/model-gateway";

const CHAT_TITLE_MAX_LENGTH = 80;

export function normalizeChatTitle(
  value: string | undefined,
  fallback = "New Thread",
) {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return fallback;
  }

  return normalized.slice(0, CHAT_TITLE_MAX_LENGTH);
}

export function normalizeGeneratedChatTitle(value: string | undefined) {
  const title = normalizeChatTitle(value?.replace(/^[\'"]+|[\'"]+$/g, ""), "");
  if (!title) {
    return null;
  }

  return (
    title.replace(/[.!?。！？]+$/u, "").slice(0, CHAT_TITLE_MAX_LENGTH).trim() ||
    null
  );
}

export function isPlaceholderThreadTitle(title: string) {
  return title.trim() === "New chat";
}

export function resolveAssistantContent(input: {
  raw: ChatCompleteResult["raw"];
}) {
  const raw = input.raw;
  const content =
    raw && typeof raw === "object"
      ? (raw as { content?: unknown }).content
      : undefined;

  const text =
    typeof content === "string"
      ? content.trim()
      : Array.isArray(content)
        ? content
            .map((part) => {
              if (typeof part === "string") {
                return part;
              }
              if (!part || typeof part !== "object") {
                return "";
              }
              const record = part as Record<string, unknown>;
              if (typeof record.text === "string") {
                return record.text;
              }
              if (typeof record.content === "string") {
                return record.content;
              }
              return "";
            })
            .filter(Boolean)
            .join("\n")
            .trim()
        : "";
  if (text.length > 0) {
    return text;
  }

  const toolCalls =
    raw && typeof raw === "object"
      ? (raw as { tool_calls?: unknown }).tool_calls
      : undefined;

  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    return toolCalls
      .map((toolCall) => {
        if (!toolCall || typeof toolCall !== "object") {
          return "";
        }
        const record = toolCall as Record<string, unknown>;
        const name = typeof record.name === "string" ? record.name : "tool";
        const args =
          record.args && typeof record.args === "object"
            ? JSON.stringify(record.args)
            : "{}";
        return `${name}: ${args}`;
      })
      .filter(Boolean)
      .join("\n");
  }

  return "Model returned an empty response.";
}
