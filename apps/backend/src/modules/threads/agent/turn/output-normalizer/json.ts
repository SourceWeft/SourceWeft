/**
 * The generic JSON and text helpers every other module here builds on: stable
 * stringification, tool-argument parsing, and pulling text or a named field out
 * of whatever shape a tool returned its output in.
 */
import { toObjectRecord } from "../../../../../shared/records";
import { isArtifactProgressToolOutputRecord } from "./shared";

export function compactTraceText(value: string, maxLength = 96) {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) {
    return compacted;
  }
  return `${compacted.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function formatDateInTimeZone(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${stableJsonStringify(item)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sameToolArgs(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
) {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

export function parseToolArgs(value: unknown): Record<string, unknown> {
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      return parseToolArgs(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return toObjectRecord(value) ?? {};
}

export function normalizeToolOutputString(value: unknown) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

export function parseJsonObjectText(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  try {
    return toObjectRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

export function extractToolOutputText(output: unknown) {
  if (typeof output === "string") {
    return output;
  }

  const record = toObjectRecord(output);
  if (!record) {
    return null;
  }

  if (typeof record.content === "string") {
    return record.content;
  }

  const kwargs =
    toObjectRecord(record.kwargs) ?? toObjectRecord(record.lc_kwargs);
  const content = kwargs?.content;
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        const itemRecord = toObjectRecord(item);
        return typeof itemRecord?.text === "string" ? itemRecord.text : null;
      })
      .filter((item): item is string => item !== null)
      .join("\n");
  }

  return null;
}

export function extractToolOutputField(output: unknown, key: string) {
  const records = collectToolOutputRecords(output);
  const orderedRecords = [
    ...records.filter((record) => isArtifactProgressToolOutputRecord(record)),
    ...records.filter((record) => !isArtifactProgressToolOutputRecord(record)),
  ];
  for (const record of orderedRecords) {
    const direct = record[key];
    if (typeof direct === "string" && direct.trim().length > 0) {
      return direct.trim();
    }
    if (typeof direct === "number" && Number.isFinite(direct)) {
      return String(direct);
    }
  }

  const outputText = extractToolOutputText(output);
  if (!outputText) {
    return null;
  }

  const match = outputText.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}

export function collectToolOutputRecords(output: unknown) {
  const records: Record<string, unknown>[] = [];
  const seen = new Set<Record<string, unknown>>();

  const push = (candidate: unknown) => {
    const record = toObjectRecord(candidate);
    if (!record || seen.has(record)) {
      return;
    }
    seen.add(record);
    records.push(record);

    const content = record.content;
    if (typeof content === "string") {
      push(parseJsonObjectText(content));
    }

    const kwargs =
      toObjectRecord(record.kwargs) ?? toObjectRecord(record.lc_kwargs);
    if (kwargs) {
      push(kwargs);
      if (typeof kwargs.content === "string") {
        push(parseJsonObjectText(kwargs.content));
      }
    }
  };

  push(output);

  if (typeof output === "string") {
    push(parseJsonObjectText(output));
  }

  const outputText = extractToolOutputText(output);
  if (outputText && outputText !== output) {
    push(parseJsonObjectText(outputText));
  }

  return records;
}

export function getPublicStringField(
  record: Record<string, unknown> | null,
  key: string,
) {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}
