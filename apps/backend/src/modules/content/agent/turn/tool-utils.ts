export type ToolCallStatus = "running" | "completed" | "error";

export function resolveToolCallId(input: {
  toolCallId?: string;
  toolName: string;
  fallbackIndex: number;
}) {
  if (typeof input.toolCallId === "string" && input.toolCallId.length > 0) {
    return input.toolCallId;
  }
  return `${input.toolName}-${input.fallbackIndex}`;
}

export function normalizeToolInput(value: unknown): Record<string, unknown> {
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      return normalizeToolInput(JSON.parse(value));
    } catch {
      return {};
    }
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function normalizeErrorText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.length > 0) {
      return record.message;
    }
    try {
      return JSON.stringify(record);
    } catch {
      return "Tool execution failed.";
    }
  }
  return "Tool execution failed.";
}
