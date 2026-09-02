import type {
  PreparedThreadTurn,
  ThinkingStepTrace,
  ToolCallTrace,
  ToolProducer,
} from "../..";
import { toObjectRecord } from "../../../../shared/records";
import {
  extractToolPayloadInput,
  parseToolArgs,
  sameToolArgs,
  stableJsonStringify,
} from "./output-normalizer";
import type { ToolCallStatus } from "./tool-utils";

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

export function extractLatestToolCallsFromAgentState(state: unknown) {
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

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const calls = extractToolCallsFromMessage(messages[index]);
    if (calls.length > 0) {
      return calls;
    }
  }

  return [] as ObservedAgentToolCall[];
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

function dedupeObservedToolCalls(candidates: ObservedAgentToolCall[]) {
  const byId = new Map<string, ObservedAgentToolCall>();
  for (const candidate of candidates) {
    const existing = byId.get(candidate.id);
    byId.set(
      candidate.id,
      existing && isMoreCompleteToolCall(existing, candidate)
        ? existing
        : candidate,
    );
  }
  return [...byId.values()];
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

export const DEEPAGENTS_TODOS_DISPLAY = "todo_list";
export const DEEPAGENTS_TODOS_VISIBILITY = "user";

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
      display: DEEPAGENTS_TODOS_DISPLAY,
      source: "deepagents",
      tool: DEEPAGENTS_WRITE_TODOS_TOOL_NAME,
      toolCallId: input.toolCallId,
      todos: input.todos,
      visibility: DEEPAGENTS_TODOS_VISIBILITY,
    },
  };
}

export type ToolsStreamToolCallSnapshot = {
  currentToolCall: ToolCallTrace;
  event: string;
  normalizedInput: Record<string, unknown>;
  pendingStartedAt?: number;
  toolCallId: string;
  toolName: string;
  toolPayload: Record<string, unknown>;
};

export type PendingToolStream = {
  normalizedInput: Record<string, unknown>;
  startedAt?: number;
  streamRunId: string;
  toolName: string;
};

export type PromotedPendingToolStream = {
  currentToolCall: ToolCallTrace;
  normalizedInput: Record<string, unknown>;
  pendingStartedAt?: number;
  toolCallId: string;
  toolName: string;
};

export function resolveToolsStreamToolCall(input: {
  pendingToolStreamsByRunId?: Map<string, PendingToolStream>;
  payload: unknown;
  producer?: ToolProducer;
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
  const streamRunId = resolveToolStreamRunId(toolPayload);
  const langchainToolCallId = resolveLangChainToolCallId(toolPayload);
  const normalizedInput = extractToolPayloadInput(toolPayload);

  if (!langchainToolCallId) {
    rememberPendingToolStream({
      event,
      normalizedInput,
      pendingToolStreamsByRunId: input.pendingToolStreamsByRunId,
      streamRunId,
      toolName,
    });
    return null;
  }

  const toolCallId = langchainToolCallId;
  const pending = streamRunId
    ? input.pendingToolStreamsByRunId?.get(streamRunId)
    : undefined;
  if (streamRunId) {
    input.pendingToolStreamsByRunId?.delete(streamRunId);
  }
  const initialInput = chooseMoreCompleteToolInput(
    pending?.normalizedInput ?? {},
    normalizedInput,
  );

  if (!input.toolCallsById.has(toolCallId)) {
    if (!input.toolCallOrder.includes(toolCallId)) {
      input.toolCallOrder.push(toolCallId);
    }
    input.toolCallsById.set(toolCallId, {
      id: toolCallId,
      tool: toolName,
      input: initialInput,
      output: null,
      status: "running" as ToolCallStatus,
      latencyMs: null,
      error: null,
      sequence: input.resolveToolCallSequence(toolCallId),
      ...(input.producer ? { producer: input.producer } : {}),
    });
  }

  const currentToolCall = input.toolCallsById.get(toolCallId);
  if (!currentToolCall) {
    return null;
  }
  // A tool's first surfaced event can be an `on_tool_end` (no prior `on_tool_start`
  // reached us), so backfill the producer onto an already-tracked trace too. The
  // apply* helpers preserve it thereafter (they spread the current trace).
  if (input.producer && !currentToolCall.producer) {
    currentToolCall.producer = input.producer;
  }

  return {
    currentToolCall,
    event,
    ...(typeof pending?.startedAt === "number"
      ? { pendingStartedAt: pending.startedAt }
      : {}),
    normalizedInput: initialInput,
    toolCallId,
    toolName,
    toolPayload,
  };
}

function resolveLangChainToolCallId(toolPayload: Record<string, unknown>) {
  for (const key of ["toolCallId", "tool_call_id"]) {
    const value = toolPayload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function resolveToolStreamRunId(toolPayload: Record<string, unknown>) {
  for (const key of ["runId", "run_id"]) {
    const value = toolPayload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function rememberPendingToolStream(input: {
  event: string;
  normalizedInput: Record<string, unknown>;
  pendingToolStreamsByRunId?: Map<string, PendingToolStream>;
  streamRunId: string | null;
  toolName: string;
}) {
  if (!input.streamRunId || !input.pendingToolStreamsByRunId) {
    return;
  }
  const existing = input.pendingToolStreamsByRunId.get(input.streamRunId);
  input.pendingToolStreamsByRunId.set(input.streamRunId, {
    normalizedInput: chooseMoreCompleteToolInput(
      existing?.normalizedInput ?? {},
      input.normalizedInput,
    ),
    startedAt:
      existing?.startedAt ??
      (input.event === "on_tool_start" ? Date.now() : undefined),
    streamRunId: input.streamRunId,
    toolName: input.toolName,
  });
}

function isToolArgsSubset(
  subset: Record<string, unknown>,
  superset: Record<string, unknown>,
) {
  return Object.entries(subset).every(
    ([key, value]) =>
      key in superset &&
      stableJsonStringify(superset[key]) === stableJsonStringify(value),
  );
}

function compatibleToolArgs(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
) {
  return (
    sameToolArgs(left, right) ||
    isToolArgsSubset(left, right) ||
    isToolArgsSubset(right, left)
  );
}

export function promotePendingToolStreamsFromToolCalls(input: {
  pendingToolStreamsByRunId: Map<string, PendingToolStream>;
  resolveToolCallSequence: (toolCallId: string) => number;
  toolCallOrder: string[];
  toolCalls: ObservedAgentToolCall[];
  toolCallsById: Map<string, ToolCallTrace>;
}): PromotedPendingToolStream[] {
  if (
    input.pendingToolStreamsByRunId.size === 0 ||
    input.toolCalls.length === 0
  ) {
    return [];
  }

  const promoted: PromotedPendingToolStream[] = [];
  const consumedPendingRunIds = new Set<string>();
  const pendingEntries = [...input.pendingToolStreamsByRunId.values()];
  for (const toolCall of dedupeObservedToolCalls(input.toolCalls)) {
    if (input.toolCallsById.has(toolCall.id)) {
      continue;
    }
    const candidates = pendingEntries.filter(
      (pending) =>
        !consumedPendingRunIds.has(pending.streamRunId) &&
        pending.toolName === toolCall.name &&
        compatibleToolArgs(pending.normalizedInput, toolCall.args),
    );
    if (candidates.length !== 1) {
      continue;
    }
    const pending = candidates[0]!;
    consumedPendingRunIds.add(pending.streamRunId);
    input.pendingToolStreamsByRunId.delete(pending.streamRunId);
    if (!input.toolCallOrder.includes(toolCall.id)) {
      input.toolCallOrder.push(toolCall.id);
    }
    const normalizedInput = chooseMoreCompleteToolInput(
      pending.normalizedInput,
      toolCall.args,
    );
    const currentToolCall: ToolCallTrace = {
      id: toolCall.id,
      tool: toolCall.name,
      input: normalizedInput,
      output: null,
      status: "running" as ToolCallStatus,
      latencyMs: null,
      error: null,
      sequence: input.resolveToolCallSequence(toolCall.id),
    };
    input.toolCallsById.set(toolCall.id, currentToolCall);
    promoted.push({
      currentToolCall,
      normalizedInput,
      ...(typeof pending.startedAt === "number"
        ? { pendingStartedAt: pending.startedAt }
        : {}),
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
  }

  return promoted;
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
    ...(input.currentToolCall.approvalState
      ? { approvalState: input.currentToolCall.approvalState }
      : {}),
    ...(input.currentToolCall.approvalConfirmationId
      ? { approvalConfirmationId: input.currentToolCall.approvalConfirmationId }
      : {}),
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
    ...(input.currentToolCall.approvalState
      ? { approvalState: input.currentToolCall.approvalState }
      : {}),
    ...(input.currentToolCall.approvalConfirmationId
      ? { approvalConfirmationId: input.currentToolCall.approvalConfirmationId }
      : {}),
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
    ...(input.currentToolCall.approvalState
      ? { approvalState: input.currentToolCall.approvalState }
      : {}),
    ...(input.currentToolCall.approvalConfirmationId
      ? { approvalConfirmationId: input.currentToolCall.approvalConfirmationId }
      : {}),
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
    ...(input.currentToolCall.approvalState
      ? { approvalState: input.currentToolCall.approvalState }
      : {}),
    ...(input.currentToolCall.approvalConfirmationId
      ? { approvalConfirmationId: input.currentToolCall.approvalConfirmationId }
      : {}),
  };
  input.toolCallsById.set(input.toolCallId, nextToolCall);
  return nextToolCall;
}
