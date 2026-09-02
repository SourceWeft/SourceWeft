/**
 * Normalizing and previewing the input side of a tool call: the few fields
 * worth showing in a trace, and digging the arguments out of whichever shape
 * the stream delivered them in.
 */
import { toObjectRecord } from "../../../../../shared/records";
import { compactTraceText } from "./json";
import { shouldRedactFilesystemToolForClient } from "./filesystem";
import { normalizeToolInput } from "../tool-utils";

const TOOL_INPUT_PREVIEW_FIELDS = [
  "query",
  "prompt",
  "url",
  "path",
  "pattern",
  "glob",
] as const;

export function formatToolInputItems(
  input: Record<string, unknown>,
  toolName?: string,
) {
  if (toolName && shouldRedactFilesystemToolForClient(toolName, input)) {
    return [];
  }
  const entries = TOOL_INPUT_PREVIEW_FIELDS.map((key) => {
    const value = input[key];
    return typeof value === "string" && value.trim().length > 0
      ? `${key}: ${compactTraceText(value)}`
      : null;
  }).filter((item): item is string => item !== null);

  const items = input.items;
  if (Array.isArray(items)) {
    for (const item of items) {
      const record = toObjectRecord(item);
      const url = typeof record?.url === "string" ? record.url.trim() : "";
      if (url) {
        entries.push(`url: ${compactTraceText(url)}`);
      }
    }
  }

  return entries.slice(0, 3);
}

export function extractToolPayloadInput(toolPayload: Record<string, unknown>) {
  for (const candidate of [toolPayload.input, toolPayload.args]) {
    const normalized = normalizeToolInput(candidate);
    if (Object.keys(normalized).length > 0) {
      return normalized;
    }
  }

  const data = toObjectRecord(toolPayload.data);
  if (!data) {
    return {};
  }

  for (const candidate of [data.input, data.args]) {
    const normalized = normalizeToolInput(candidate);
    if (Object.keys(normalized).length > 0) {
      return normalized;
    }
  }

  return {};
}
