import type {
  ModelReasoningSegmentTrace,
  ThinkingStepTrace,
  ToolCallTrace,
} from "./types";

export type TracePartBase = {
  id: string;
  kind: "reasoning" | "tool" | "step";
  order: number;
  createdAt: string;
  updatedAt: string;
};

export type ReasoningTracePart = TracePartBase & {
  kind: "reasoning";
  text: string;
  phase?: "initial" | "after_tool";
  toolCallId?: string;
  tool?: string;
  durationMs?: number;
};

export type ToolTracePart = TracePartBase & {
  kind: "tool";
  toolCallId: string;
  tool: string;
  status: ToolCallTrace["status"];
  input: Record<string, unknown>;
  output?: unknown;
  error?: string | null;
  latencyMs?: number | null;
  title?: string;
  approvalState?: ToolCallTrace["approvalState"];
  approvalConfirmationId?: string;
};

export type StepTracePart = TracePartBase & {
  kind: "step";
  title: string;
  status: ThinkingStepTrace["status"];
  items: string[];
  metadata?: Record<string, unknown>;
};

export type TracePart = ReasoningTracePart | ToolTracePart | StepTracePart;

type TracePartCandidate =
  | Omit<ReasoningTracePart, "order" | "createdAt" | "updatedAt">
  | Omit<ToolTracePart, "order" | "createdAt" | "updatedAt">
  | Omit<StepTracePart, "order" | "createdAt" | "updatedAt">;

function nowIso() {
  return new Date().toISOString();
}

function getObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getTracePartId(part: TracePartCandidate | TracePart) {
  if (part.kind === "tool") {
    return part.toolCallId;
  }
  return part.id;
}

function getTracePartOrder(part: unknown) {
  const order = getObjectRecord(part)?.order;
  return typeof order === "number" && Number.isFinite(order) ? order : null;
}

export function normalizeTraceParts(value: unknown): TracePart[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((part, index) => {
      const record = getObjectRecord(part);
      if (!record) {
        return null;
      }
      const id = typeof record.id === "string" ? record.id : null;
      const kind = record.kind;
      const order = getTracePartOrder(record) ?? index;
      const createdAt =
        typeof record.createdAt === "string" ? record.createdAt : nowIso();
      const updatedAt =
        typeof record.updatedAt === "string" ? record.updatedAt : createdAt;
      if (!id || (kind !== "reasoning" && kind !== "tool" && kind !== "step")) {
        return null;
      }
      if (kind === "reasoning") {
        const text = typeof record.text === "string" ? record.text : "";
        if (!text) {
          return null;
        }
        return {
          id,
          kind,
          order,
          createdAt,
          updatedAt,
          text,
          ...(record.phase === "initial" || record.phase === "after_tool"
            ? { phase: record.phase }
            : {}),
          ...(typeof record.toolCallId === "string"
            ? { toolCallId: record.toolCallId }
            : {}),
          ...(typeof record.tool === "string" ? { tool: record.tool } : {}),
          ...(typeof record.durationMs === "number" &&
          Number.isFinite(record.durationMs)
            ? { durationMs: record.durationMs }
            : {}),
        } satisfies ReasoningTracePart;
      }
      if (kind === "tool") {
        const toolCallId =
          typeof record.toolCallId === "string" ? record.toolCallId : id;
        const tool = typeof record.tool === "string" ? record.tool : "";
        const input = getObjectRecord(record.input) ?? {};
        const status =
          record.status === "approval_requested" ||
          record.status === "completed" ||
          record.status === "error"
            ? record.status
            : "running";
        return {
          id,
          kind,
          order,
          createdAt,
          updatedAt,
          toolCallId,
          tool,
          status,
          input,
          ...(record.output !== undefined ? { output: record.output } : {}),
          ...(typeof record.error === "string" || record.error === null
            ? { error: record.error }
            : {}),
          ...(typeof record.latencyMs === "number" || record.latencyMs === null
            ? { latencyMs: record.latencyMs }
            : {}),
          ...(typeof record.title === "string" ? { title: record.title } : {}),
          ...(record.approvalState === "approved" ||
          record.approvalState === "rejected"
            ? { approvalState: record.approvalState }
            : {}),
          ...(typeof record.approvalConfirmationId === "string"
            ? { approvalConfirmationId: record.approvalConfirmationId }
            : {}),
        } satisfies ToolTracePart;
      }

      const title = typeof record.title === "string" ? record.title : id;
      const items = Array.isArray(record.items)
        ? record.items.filter((item): item is string => typeof item === "string")
        : [];
      const status =
        record.status === "pending" ||
        record.status === "in_progress" ||
        record.status === "completed"
          ? record.status
          : "pending";
      return {
        id,
        kind,
        order,
        createdAt,
        updatedAt,
        title,
        status,
        items,
        ...(getObjectRecord(record.metadata)
          ? { metadata: getObjectRecord(record.metadata)! }
          : {}),
      } satisfies StepTracePart;
    })
    .filter((part): part is TracePart => part !== null)
    .sort((left, right) => left.order - right.order);
}

export function upsertTracePart(
  parts: unknown,
  candidate: TracePartCandidate | null,
): TracePart[] {
  const current = normalizeTraceParts(parts);
  if (!candidate) {
    return current;
  }

  const id = getTracePartId(candidate);
  const now = nowIso();
  const index = current.findIndex((part) => getTracePartId(part) === id);
  if (index < 0) {
    return [
      ...current,
      {
        ...candidate,
        id,
        order: current.length,
        createdAt: now,
        updatedAt: now,
      } as TracePart,
    ];
  }

  const existing = current[index]!;
  return current.map((part, partIndex) =>
    partIndex === index
      ? ({
          ...existing,
          ...candidate,
          id: existing.id,
          order: existing.order,
          createdAt: existing.createdAt,
          updatedAt: now,
        } as TracePart)
      : part,
  );
}

export function tracePartFromReasoningSegment(
  segment: ModelReasoningSegmentTrace,
): TracePartCandidate {
  return {
    kind: "reasoning",
    id: segment.id,
    text: segment.text,
    ...(segment.phase ? { phase: segment.phase } : {}),
    ...(segment.toolCallId ? { toolCallId: segment.toolCallId } : {}),
    ...(segment.tool ? { tool: segment.tool } : {}),
    ...(segment.durationMs !== undefined ? { durationMs: segment.durationMs } : {}),
  };
}

export function tracePartFromToolCall(
  toolCall: ToolCallTrace,
): TracePartCandidate {
  return {
    kind: "tool",
    id: toolCall.id,
    toolCallId: toolCall.id,
    tool: toolCall.tool,
    status: toolCall.status,
    input: toolCall.input,
    ...(toolCall.output !== undefined ? { output: toolCall.output } : {}),
    error: toolCall.error,
    latencyMs: toolCall.latencyMs,
    ...(toolCall.approvalState
      ? { approvalState: toolCall.approvalState }
      : {}),
    ...(toolCall.approvalConfirmationId
      ? { approvalConfirmationId: toolCall.approvalConfirmationId }
      : {}),
  };
}

export function tracePartFromThinkingStep(
  step: ThinkingStepTrace,
): TracePartCandidate {
  return {
    kind: "step",
    id: step.id,
    title: step.title,
    status: step.status,
    items: step.items,
    ...(step.metadata ? { metadata: step.metadata } : {}),
  };
}
