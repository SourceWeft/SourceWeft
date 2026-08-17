import type { ToolCallRecord } from "./types";

/** deepagents' delegation tool. A call to it is a sub-agent delegation. */
export const TASK_TOOL_NAME = "task";

export function isDelegateToolName(tool: string): boolean {
  return tool === TASK_TOOL_NAME;
}

export interface DelegateToolView {
  /** The selected delegate (`subagent_type`), e.g. "explore" / "plan". */
  subagentType: string;
  /** The prompt/description handed to the delegate. */
  prompt: string;
  /** The delegate's returned report, or null while running / when absent. */
  report: string | null;
  status: ToolCallRecord["status"];
}

/**
 * Project a `task` tool call into the delegate view. Everything comes from the
 * tool call already on the main stream (args + result) — no subgraph streaming.
 */
export function parseDelegateToolCall(
  toolCall: ToolCallRecord,
): DelegateToolView {
  const input = toolCall.input ?? {};
  const subagentTypeRaw = input.subagent_type;
  const subagentType =
    typeof subagentTypeRaw === "string" && subagentTypeRaw.trim().length > 0
      ? subagentTypeRaw.trim()
      : "subagent";
  const prompt = typeof input.description === "string" ? input.description : "";
  return {
    subagentType,
    prompt,
    report: extractReport(toolCall.output),
    status: toolCall.status,
  };
}

/** Best-effort readable report from the tool output (string, {summary}, JSON). */
export function extractReport(output: unknown): string | null {
  if (output == null) {
    return null;
  }
  if (typeof output === "string") {
    return output.length > 0 ? output : null;
  }
  if (typeof output === "object") {
    const record = output as Record<string, unknown>;
    if (typeof record.summary === "string" && record.summary.length > 0) {
      return record.summary;
    }
    try {
      return JSON.stringify(output);
    } catch {
      return null;
    }
  }
  return String(output);
}
