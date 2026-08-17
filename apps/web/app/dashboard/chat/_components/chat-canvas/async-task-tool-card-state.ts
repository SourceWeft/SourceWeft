import type { ToolCallRecord } from "./types";

/**
 * deepagents' async (background) sub-agent task tools. A call to any of them
 * operates a background delegate over the self-hosted runs endpoint — distinct
 * from the synchronous `task` delegation tool.
 */
export const ASYNC_TASK_TOOL_NAMES = {
  start: "start_async_task",
  check: "check_async_task",
  update: "update_async_task",
  cancel: "cancel_async_task",
  list: "list_async_tasks",
} as const;

const ASYNC_TASK_TOOL_NAME_SET: ReadonlySet<string> = new Set(
  Object.values(ASYNC_TASK_TOOL_NAMES),
);

export function isAsyncTaskToolName(tool: string): boolean {
  return ASYNC_TASK_TOOL_NAME_SET.has(tool);
}

export type AsyncTaskVerb = keyof typeof ASYNC_TASK_TOOL_NAMES;

export interface AsyncTaskToolView {
  verb: AsyncTaskVerb;
  /** The background delegate type (e.g. `explore-async`), when the call names one. */
  agentName: string | null;
  /** The task id the verb targets / returns, when present. */
  taskId: string | null;
  /** The brief (start) or follow-up instructions (update). */
  instructions: string | null;
  /** For `check`: the delegate's reported live status, e.g. "running"/"success". */
  reportedStatus: string | null;
  /** For `check`: the delegate's result once complete. */
  result: string | null;
  /** For `list`: the rendered task listing. */
  listing: string | null;
  status: ToolCallRecord["status"];
}

function verbOf(tool: string): AsyncTaskVerb {
  for (const [verb, name] of Object.entries(ASYNC_TASK_TOOL_NAMES)) {
    if (name === tool) {
      return verb as AsyncTaskVerb;
    }
  }
  return "start";
}

function toText(output: unknown): string {
  if (output == null) {
    return "";
  }
  if (typeof output === "string") {
    return output;
  }
  if (typeof output === "object") {
    const record = output as Record<string, unknown>;
    if (typeof record.content === "string") {
      return record.content;
    }
    try {
      return JSON.stringify(output);
    } catch {
      return "";
    }
  }
  return String(output);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * Project an async task tool call into a view, from the tool call already on the
 * main stream (args + result). `check` results are the JSON the endpoint returns
 * (`{ status, result }`); the launch/update/cancel outputs carry the task id in
 * a human string (`… taskId: <id>`).
 */
export function parseAsyncTaskToolCall(
  toolCall: ToolCallRecord,
): AsyncTaskToolView {
  const verb = verbOf(toolCall.tool);
  const input = toolCall.input ?? {};
  const text = toText(toolCall.output);

  let reportedStatus: string | null = null;
  let result: string | null = null;
  if (verb === "check") {
    try {
      const parsed = JSON.parse(text) as {
        status?: unknown;
        result?: unknown;
        error?: unknown;
      };
      reportedStatus = optionalString(parsed.status);
      result = optionalString(parsed.result) ?? optionalString(parsed.error);
    } catch {
      result = optionalString(text);
    }
  }

  const taskFromArgs = optionalString(input.taskId);
  const taskFromOutput = /taskId:\s*(\S+)/.exec(text)?.[1] ?? null;

  return {
    verb,
    agentName: optionalString(input.agentName),
    taskId: taskFromArgs ?? taskFromOutput,
    instructions:
      optionalString(input.description) ?? optionalString(input.message),
    reportedStatus,
    result,
    listing: verb === "list" ? optionalString(text) : null,
    status: toolCall.status,
  };
}
