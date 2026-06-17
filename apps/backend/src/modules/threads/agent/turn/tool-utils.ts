import type { PreparedThreadTurn } from "../..";
import { isAgentToolEnabledByDefault } from "@sourceweft/agent-tool-registry";

export type ToolCallStatus =
  | "running"
  | "approval_requested"
  | "completed"
  | "error";

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

export function looksLikeRawToolCallText(value: string) {
  const text = value.trimStart();
  return (
    /^<｜DSML｜tool_calls>/u.test(text) ||
    /^<｜DSML｜invoke\s+name=/u.test(text) ||
    /^<\|tool_calls\|>/i.test(text) ||
    /^<tool_calls>/i.test(text) ||
    /^<tool_call\b/i.test(text)
  );
}

export function looksLikeArtifactUrlLeakText(value: string) {
  return /(?:artifact_id|artifact_url|html_url|pptx_url|source_json_url)\s*[:=]/i.test(
    value,
  );
}

export function isMcpToolName(toolName: string) {
  return toolName.startsWith("mcp__");
}

export function getMcpToolDisplayName(toolName: string) {
  return toolName
    .replace(/^mcp__/, "")
    .split("__")
    .filter(Boolean)
    .join(".");
}

export function getToolPermission(
  prepared: PreparedThreadTurn,
  toolName: string,
): "allow" | "ask" | "deny" {
  return prepared.toolPermissions[toolName] ?? "allow";
}

export function isToolDenied(prepared: PreparedThreadTurn, toolName: string) {
  return getToolPermission(prepared, toolName) === "deny";
}

export function filterAllowedTools<T extends { name: string }>(
  prepared: PreparedThreadTurn,
  tools: T[],
) {
  return tools.filter((tool) => !isToolDenied(prepared, tool.name));
}

export function shouldBindAgentTool(input: {
  prepared: PreparedThreadTurn;
  toolName: string;
}) {
  const runtimeTool = input.prepared.runtimeTools[input.toolName];
  if (runtimeTool) {
    return runtimeTool.shouldBind;
  }
  const command = input.prepared.command;
  if (command?.workflow?.defaultTools.includes(input.toolName)) {
    return true;
  }
  if (command?.kind === "tool") {
    return command.toolName === input.toolName;
  }
  const invocation = input.prepared.invocation;
  if (
    invocation?.kind === "fixed_tool_choice" &&
    invocation.target === "capability_tool"
  ) {
    return invocation.toolName === input.toolName;
  }
  return isAgentToolEnabledByDefault(input.toolName);
}

export function resolveSourceUserMessageId(prepared: PreparedThreadTurn) {
  const metadata = prepared.userMessage.metadata;
  const versionOf =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).versionOf
      : null;
  return typeof versionOf === "string" && versionOf.length > 0
    ? versionOf
    : prepared.userMessage.id;
}
