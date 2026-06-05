import type {
  PreparedThreadTurn,
  ThinkingStepTrace,
  ToolCallTrace,
} from "../../threads";
import { toObjectRecord } from "./content";
import { extractToolPayloadInput, parseToolArgs } from "./output-normalizer";
import { resolveToolCallId, type ToolCallStatus } from "./tool-utils";

export type ObservedAgentToolCall = {
  args: Record<string, unknown>;
  id: string;
  index?: number;
  name: string;
};

export function extractToolCallsFromRawProvider(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as ObservedAgentToolCall[];
  }
  return value
    .map((candidate, index): ObservedAgentToolCall | null => {
      const record = toObjectRecord(candidate);
      if (!record) {
        return null;
      }
      const functionRecord = toObjectRecord(record.function);
      const name =
        typeof record.name === "string"
          ? record.name
          : typeof functionRecord?.name === "string"
            ? functionRecord.name
            : null;
      const id = typeof record.id === "string" ? record.id : null;
      if (!name || !id) {
        return null;
      }
      return {
        id,
        name,
        args: parseToolArgs(functionRecord?.arguments ?? record.args),
        index:
          typeof record.index === "number" && Number.isFinite(record.index)
            ? record.index
            : index,
      };
    })
    .filter((call): call is ObservedAgentToolCall => call !== null);
}

export function extractToolCallsFromContentBlocks(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as ObservedAgentToolCall[];
  }
  return value
    .map((candidate, index): ObservedAgentToolCall | null => {
      const record = toObjectRecord(candidate);
      if (!record) {
        return null;
      }
      const type = typeof record.type === "string" ? record.type : "";
      if (type !== "tool_call" && type !== "tool_use") {
        return null;
      }
      const name =
        typeof record.name === "string"
          ? record.name
          : typeof record.tool_name === "string"
            ? record.tool_name
            : null;
      const id = typeof record.id === "string" ? record.id : null;
      if (!name || !id) {
        return null;
      }
      return {
        id,
        name,
        args: parseToolArgs(record.args ?? record.input),
        index:
          typeof record.index === "number" && Number.isFinite(record.index)
            ? record.index
            : index,
      };
    })
    .filter((call): call is ObservedAgentToolCall => call !== null);
}

export function extractToolCallsFromMessage(value: unknown) {
  const record = toObjectRecord(value);
  if (!record) {
    return [] as ObservedAgentToolCall[];
  }
  const directCalls = Array.isArray(record.tool_calls)
    ? record.tool_calls
    : Array.isArray(record.toolCalls)
      ? record.toolCalls
      : [];
  const normalizedDirect = directCalls
    .map((candidate, index): ObservedAgentToolCall | null => {
      const call = toObjectRecord(candidate);
      if (!call) {
        return null;
      }
      const id = typeof call?.id === "string" ? call.id : null;
      const name = typeof call?.name === "string" ? call.name : null;
      if (!id || !name) {
        return null;
      }
      return {
        id,
        name,
        args: parseToolArgs(
          call.args ?? toObjectRecord(call.function)?.arguments,
        ),
        index,
      };
    })
    .filter((call): call is ObservedAgentToolCall => call !== null);
  const contentBlockCalls = [
    ...extractToolCallsFromContentBlocks(record.contentBlocks),
    ...extractToolCallsFromContentBlocks(record.content_blocks),
    ...extractToolCallsFromContentBlocks(record.content),
  ];
  const rawCalls = extractToolCallsFromRawProvider(
    toObjectRecord(record.additional_kwargs)?.tool_calls ??
      toObjectRecord(toObjectRecord(record.lc_kwargs)?.additional_kwargs)
        ?.tool_calls,
  );
  return [...normalizedDirect, ...contentBlockCalls, ...rawCalls];
}

export function extractToolCallsFromUpdates(payload: unknown) {
  const updates = toObjectRecord(payload);
  if (!updates) {
    return [] as ObservedAgentToolCall[];
  }
  const calls: ObservedAgentToolCall[] = [];
  for (const value of Object.values(updates)) {
    const update = toObjectRecord(value);
    if (!update) {
      continue;
    }
    const messages = Array.isArray(update.messages) ? update.messages : [];
    for (const message of messages) {
      calls.push(...extractToolCallsFromMessage(message));
    }
  }
  return calls;
}

export function extractToolCallsFromAgentState(state: unknown) {
  const record = toObjectRecord(state);
  if (!record) {
    return [] as ObservedAgentToolCall[];
  }

  const values = toObjectRecord(record.values);
  const messages = Array.isArray(values?.messages)
    ? values.messages
    : Array.isArray(record.messages)
      ? record.messages
      : [];

  return messages.flatMap((message) => extractToolCallsFromMessage(message));
}

export function rememberObservedToolCalls(
  target: Map<string, ObservedAgentToolCall>,
  calls: ObservedAgentToolCall[],
) {
  for (const call of calls) {
    const existing = target.get(call.id);
    if (!existing || isMoreCompleteToolCall(call, existing)) {
      target.set(call.id, call);
    }
  }
}

function isMoreCompleteToolCall(
  candidate: ObservedAgentToolCall,
  existing: ObservedAgentToolCall,
) {
  const candidateArgCount = Object.keys(candidate.args).length;
  const existingArgCount = Object.keys(existing.args).length;
  if (candidateArgCount !== existingArgCount) {
    return candidateArgCount > existingArgCount;
  }
  return (
    candidate.name === existing.name &&
    JSON.stringify(candidate.args).length > JSON.stringify(existing.args).length
  );
}

export function createTraceSequenceAllocator(input: {
  traceContinuation: PreparedThreadTurn["traceContinuation"];
  snapshotToolCalls?: ReadonlyArray<{ id: string; sequence?: number | null }>;
}) {
  let eventSequence = input.traceContinuation?.maxSequence ?? 0;
  const toolSequenceById = new Map(
    Object.entries(input.traceContinuation?.toolSequenceById ?? {}),
  );
  for (const toolCall of input.snapshotToolCalls ?? []) {
    if (typeof toolCall.id !== "string" || toolCall.id.length === 0) {
      continue;
    }
    if (toolSequenceById.has(toolCall.id)) {
      continue;
    }
    if (
      typeof toolCall.sequence === "number" &&
      Number.isFinite(toolCall.sequence) &&
      toolCall.sequence > 0
    ) {
      toolSequenceById.set(toolCall.id, toolCall.sequence);
      eventSequence = Math.max(eventSequence, toolCall.sequence);
    }
  }
  const nextSequence = () => {
    eventSequence += 1;
    return eventSequence;
  };
  const resolveToolCallSequence = (toolCallId: string) => {
    const existing = toolSequenceById.get(toolCallId);
    if (typeof existing === "number") {
      return existing;
    }
    const sequence = nextSequence();
    toolSequenceById.set(toolCallId, sequence);
    return sequence;
  };

  return {
    nextSequence,
    resolveToolCallSequence,
  };
}

export const DEEPAGENTS_WRITE_TODOS_TOOL_NAME = "write_todos";

const DEEPAGENTS_TODOS_STEP_ID = "deepagents:todos";

export type DeepAgentTodo = {
  content: string;
  status: "pending" | "in_progress" | "completed";
};

const TODO_STATUS_LABELS: Record<DeepAgentTodo["status"], string> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
};

export function isDeepAgentsWriteTodosTool(toolName: string) {
  return toolName === DEEPAGENTS_WRITE_TODOS_TOOL_NAME;
}

export function parseDeepAgentTodos(
  input: Record<string, unknown>,
): DeepAgentTodo[] {
  const todos = input.todos;
  if (!Array.isArray(todos)) {
    return [];
  }

  return todos
    .map((item) => {
      const record = toObjectRecord(item);
      const content =
        typeof record?.content === "string" ? record.content.trim() : "";
      const status = record?.status;
      if (
        !content ||
        (status !== "pending" &&
          status !== "in_progress" &&
          status !== "completed")
      ) {
        return null;
      }

      return {
        content,
        status,
      };
    })
    .filter((item): item is DeepAgentTodo => item !== null);
}

export function resolveDeepAgentTodosStepStatus(
  todos: DeepAgentTodo[],
): ThinkingStepTrace["status"] {
  if (todos.some((todo) => todo.status === "in_progress")) {
    return "in_progress";
  }
  if (todos.length > 0 && todos.every((todo) => todo.status === "completed")) {
    return "completed";
  }
  return "pending";
}

export function buildDeepAgentTodosStep(input: {
  toolCallId: string;
  todos: DeepAgentTodo[];
}): Omit<ThinkingStepTrace, "sequence"> {
  return {
    id: DEEPAGENTS_TODOS_STEP_ID,
    kind: "state",
    title: "Task plan",
    status: resolveDeepAgentTodosStepStatus(input.todos),
    items: input.todos.map(
      (todo) => `${TODO_STATUS_LABELS[todo.status]}: ${todo.content}`,
    ),
    metadata: {
      source: "deepagents",
      tool: DEEPAGENTS_WRITE_TODOS_TOOL_NAME,
      toolCallId: input.toolCallId,
      todos: input.todos,
    },
  };
}

export type ToolsStreamToolCallSnapshot = {
  currentToolCall: ToolCallTrace;
  event: string;
  normalizedInput: Record<string, unknown>;
  toolCallId: string;
  toolName: string;
  toolPayload: Record<string, unknown>;
};

export function resolveToolsStreamToolCall(input: {
  payload: unknown;
  resolveToolCallSequence: (toolCallId: string) => number;
  toolCallOrder: string[];
  toolCallsById: Map<string, ToolCallTrace>;
}): ToolsStreamToolCallSnapshot | null {
  const toolPayload = toObjectRecord(input.payload);
  if (!toolPayload) {
    return null;
  }

  const event = typeof toolPayload.event === "string" ? toolPayload.event : "";
  const toolName =
    typeof toolPayload.name === "string" && toolPayload.name.length > 0
      ? toolPayload.name
      : "tool";
  const stableToolCallId = resolveStableToolStreamId(toolPayload);
  const toolCallId = stableToolCallId
    ? resolveToolCallId({
        toolCallId: stableToolCallId,
        toolName,
        fallbackIndex: input.toolCallOrder.length + 1,
      })
    : resolveUnstableToolStreamId({
        event,
        toolCallOrder: input.toolCallOrder,
        toolCallsById: input.toolCallsById,
        toolName,
      });

  if (!toolCallId) {
    return null;
  }

  if (!input.toolCallsById.has(toolCallId)) {
    input.toolCallOrder.push(toolCallId);
    input.toolCallsById.set(toolCallId, {
      id: toolCallId,
      tool: toolName,
      input: {},
      output: null,
      status: "running" as ToolCallStatus,
      latencyMs: null,
      error: null,
      sequence: input.resolveToolCallSequence(toolCallId),
    });
  }

  const currentToolCall = input.toolCallsById.get(toolCallId);
  if (!currentToolCall) {
    return null;
  }

  return {
    currentToolCall,
    event,
    normalizedInput: extractToolPayloadInput(toolPayload),
    toolCallId,
    toolName,
    toolPayload,
  };
}

function resolveStableToolStreamId(toolPayload: Record<string, unknown>) {
  for (const key of ["toolCallId", "tool_call_id", "runId", "run_id", "id"]) {
    const value = toolPayload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function resolveUnstableToolStreamId(input: {
  event: string;
  toolCallOrder: string[];
  toolCallsById: Map<string, ToolCallTrace>;
  toolName: string;
}) {
  if (input.event === "on_tool_start") {
    return `${input.toolName}-${input.toolCallOrder.length + 1}`;
  }

  const runningMatches = Array.from(input.toolCallsById.values()).filter(
    (call) => call.tool === input.toolName && call.status === "running",
  );
  return runningMatches.length === 1 ? runningMatches[0]?.id ?? null : null;
}

export function applyToolsStreamToolStart(input: {
  currentToolCall: ToolCallTrace;
  normalizedInput: Record<string, unknown>;
  toolCallId: string;
  toolCallsById: Map<string, ToolCallTrace>;
  toolName: string;
}) {
  const nextToolCall: ToolCallTrace = {
    ...input.currentToolCall,
    tool: input.toolName,
    input: input.normalizedInput,
    status: "running",
    error: null,
  };
  input.toolCallsById.set(input.toolCallId, nextToolCall);
  return nextToolCall;
}

export function applyToolsStreamToolEvent(input: {
  currentToolCall: ToolCallTrace;
  output: unknown;
  toolCallId: string;
  toolCallsById: Map<string, ToolCallTrace>;
  toolName: string;
}) {
  const nextToolCall: ToolCallTrace = {
    ...input.currentToolCall,
    tool: input.toolName,
    output: input.output,
    status: "running",
    error: null,
  };
  input.toolCallsById.set(input.toolCallId, nextToolCall);
  return nextToolCall;
}

export function applyToolsStreamToolEnd(input: {
  currentToolCall: ToolCallTrace;
  latencyMs: number | null;
  normalizedInput: Record<string, unknown>;
  output: unknown;
  toolCallId: string;
  toolCallsById: Map<string, ToolCallTrace>;
  toolName: string;
  toolStatus: Exclude<ToolCallStatus, "running" | "approval_requested">;
  error: string | null;
}) {
  const nextToolCall: ToolCallTrace = {
    ...input.currentToolCall,
    tool: input.toolName,
    input: chooseMoreCompleteToolInput(
      input.currentToolCall.input,
      input.normalizedInput,
    ),
    output: input.output,
    status: input.toolStatus,
    latencyMs: input.latencyMs,
    error: input.error,
  };
  input.toolCallsById.set(input.toolCallId, nextToolCall);
  return nextToolCall;
}

function chooseMoreCompleteToolInput(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
) {
  const currentKeyCount = Object.keys(current).length;
  const nextKeyCount = Object.keys(next).length;
  if (nextKeyCount === 0) {
    return current;
  }
  if (currentKeyCount === 0 || nextKeyCount > currentKeyCount) {
    return next;
  }
  return JSON.stringify(next).length > JSON.stringify(current).length
    ? next
    : current;
}

export function applyToolsStreamToolError(input: {
  currentToolCall: ToolCallTrace;
  error: string;
  latencyMs: number | null;
  toolCallId: string;
  toolCallsById: Map<string, ToolCallTrace>;
  toolName: string;
}) {
  const nextToolCall: ToolCallTrace = {
    ...input.currentToolCall,
    tool: input.toolName,
    status: "error",
    latencyMs: input.latencyMs,
    error: input.error,
  };
  input.toolCallsById.set(input.toolCallId, nextToolCall);
  return nextToolCall;
}
