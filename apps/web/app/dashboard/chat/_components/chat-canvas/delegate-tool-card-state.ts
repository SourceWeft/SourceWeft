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

/**
 * Best-effort readable report from the tool output.
 *
 * deepagents' `task` tool returns a LangGraph `Command`, not a plain string, so
 * the raw output reaching the client is
 * `{ update: { messages: [ToolMessage], ... }, lg_name: "Command" }`. The actual
 * report prose (markdown) lives at `update.messages[last].kwargs.content`. We
 * unwrap that here instead of dumping the whole Command wrapper as JSON. The
 * plain-string branch still covers the rare no-tool-call fallback path, and an
 * error/partial result falls through to `null` rather than leaking the wrapper.
 */
/**
 * Short task label for the delegate header chip (LobeChat-style pill): the
 * first non-empty line of the brief, trimmed to its first sentence and capped.
 * Returns null when the brief is empty so the caller can fall back to the type.
 */
export function getDelegateChipTitle(prompt: string): string | null {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return null;
  }
  const sentenceEnd = firstLine.search(/[。.!?！？]/u);
  let title =
    sentenceEnd > 0 ? firstLine.slice(0, sentenceEnd + 1) : firstLine;
  const MAX_CHARS = 48;
  if (title.length > MAX_CHARS) {
    title = `${title.slice(0, MAX_CHARS).trimEnd()}…`;
  }
  return title;
}

export function extractReport(output: unknown): string | null {
  if (output == null) {
    return null;
  }
  if (typeof output === "string") {
    return output.length > 0 ? output : null;
  }
  if (typeof output === "object") {
    const record = output as Record<string, unknown>;
    const commandContent = extractCommandReportContent(record);
    if (commandContent) {
      return commandContent;
    }
    if (typeof record.summary === "string" && record.summary.length > 0) {
      return record.summary;
    }
    return null;
  }
  return String(output);
}

/** Pull the last ToolMessage's content out of a serialized LangGraph Command. */
function extractCommandReportContent(
  record: Record<string, unknown>,
): string | null {
  const update = record.update;
  if (update == null || typeof update !== "object") {
    return null;
  }
  const messages = (update as Record<string, unknown>).messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }
  const last = messages[messages.length - 1];
  if (last == null || typeof last !== "object") {
    return null;
  }
  // LangChain serializes a ToolMessage as { kwargs: { content } }; some
  // serializers mirror it under lc_kwargs. Content may be a string or an array
  // of { type, text } blocks.
  const kwargs =
    (last as Record<string, unknown>).kwargs ??
    (last as Record<string, unknown>).lc_kwargs;
  if (kwargs == null || typeof kwargs !== "object") {
    return null;
  }
  return normalizeMessageContent((kwargs as Record<string, unknown>).content);
}

/** Normalize LangChain message content (string or text blocks) to a string. */
function normalizeMessageContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content.length > 0 ? content : null;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        part &&
        typeof part === "object" &&
        typeof (part as Record<string, unknown>).text === "string"
          ? ((part as Record<string, unknown>).text as string)
          : "",
      )
      .join("");
    return text.length > 0 ? text : null;
  }
  return null;
}
