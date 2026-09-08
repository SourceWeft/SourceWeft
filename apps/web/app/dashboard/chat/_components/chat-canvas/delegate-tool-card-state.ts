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
  /**
   * The child thread the server projected this delegate's run into, once the
   * call finished; null while running or when the run was not projected.
   */
  childThreadId: string | null;
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
    childThreadId: readDelegateChildThreadId(toolCall.output),
    status: toolCall.status,
  };
}

/**
 * The child thread a finished delegate was projected into. The server tags the
 * `task` result under a namespaced `sourceweft.childThreadId` key so no new
 * event or field was needed; a result without the tag is simply not openable.
 */
export function readDelegateChildThreadId(output: unknown): string | null {
  if (output == null || typeof output !== "object") {
    return null;
  }
  const marker = (output as Record<string, unknown>).sourceweft;
  if (marker == null || typeof marker !== "object") {
    return null;
  }
  const childThreadId = (marker as Record<string, unknown>).childThreadId;
  return typeof childThreadId === "string" && childThreadId.length > 0
    ? childThreadId
    : null;
}

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
  let title = sentenceEnd > 0 ? firstLine.slice(0, sentenceEnd + 1) : firstLine;
  const MAX_CHARS = 48;
  if (title.length > MAX_CHARS) {
    title = `${title.slice(0, MAX_CHARS).trimEnd()}…`;
  }
  return title;
}

/**
 * Best-effort readable report from the tool output.
 *
 * Under v3 the `task` tool's result reaches the client as the delegate's plain
 * report string, or — once the server has projected the run into a child
 * thread — as `{ report, sourceweft: { childThreadId } }`. The legacy raw shape
 * is deepagents' serialized LangGraph `Command`
 * (`{ update: { messages: [ToolMessage] }, lg_name: "Command" }`), whose report
 * prose lives at `update.messages[last].kwargs.content`. All three are handled
 * here so the card never dumps a wrapper as JSON; an error/partial result falls
 * through to `null`.
 */
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
    if (typeof record.report === "string" && record.report.length > 0) {
      return record.report;
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
