import type {
  ThinkingStepRecord,
  ToolCallRecord,
  TracePartRecord,
} from "./types";

export type AssistantActivityItem =
  | {
      durationMs?: number;
      id: string;
      key: string;
      order: number;
      phase?: "initial" | "after_tool";
      text: string;
      tool?: string;
      toolCallId?: string;
      type: "reasoning";
    }
  | {
      detail?: string | null;
      id: string;
      items: string[];
      key: string;
      metadata?: Record<string, unknown>;
      order: number;
      status: ThinkingStepRecord["status"];
      title: string;
      toolCallId?: string;
      type: "step";
    }
  | {
      id: string;
      key: string;
      order: number;
      toolCall: ToolCallRecord;
      toolStep?: ThinkingStepRecord;
      type: "tool";
    };

function uniqueToolCalls(toolCalls: ToolCallRecord[] | undefined) {
  return (toolCalls ?? []).filter((toolCall, index, calls) => {
    return calls.findIndex((call) => call.id === toolCall.id) === index;
  });
}

function buildStepByToolCallId(steps: ThinkingStepRecord[] | undefined) {
  return new Map(
    (steps ?? [])
      .map((step) => {
        const toolCallId = step.metadata?.toolCallId;
        return typeof toolCallId === "string"
          ? ([toolCallId, step] as const)
          : null;
      })
      .filter(
        (entry): entry is readonly [string, ThinkingStepRecord] =>
          entry !== null,
      ),
  );
}

function buildToolCallFromPart(input: {
  matchedToolCall?: ToolCallRecord;
  part: Extract<TracePartRecord, { kind: "tool" }>;
}): ToolCallRecord {
  const { matchedToolCall, part } = input;
  return {
    id: part.toolCallId,
    tool: part.tool,
    input: part.input,
    output: part.output ?? matchedToolCall?.output,
    latencyMs: part.latencyMs ?? matchedToolCall?.latencyMs ?? null,
    status: part.status,
    error: part.error ?? matchedToolCall?.error ?? null,
    sequence: part.order,
    ...((part.approvalState ?? matchedToolCall?.approvalState)
      ? { approvalState: part.approvalState ?? matchedToolCall?.approvalState }
      : {}),
    ...((part.approvalConfirmationId ?? matchedToolCall?.approvalConfirmationId)
      ? {
          approvalConfirmationId:
            part.approvalConfirmationId ??
            matchedToolCall?.approvalConfirmationId,
        }
      : {}),
  };
}

function normalizeTraceText(value: string | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function isAssistantAnswerLikeReasoning(input: {
  assistantText?: string;
  reasoningText: string;
}) {
  const assistantText = normalizeTraceText(input.assistantText);
  const reasoningText = normalizeTraceText(input.reasoningText);
  if (assistantText.length === 0 || reasoningText.length === 0) {
    return false;
  }

  if (assistantText === reasoningText) {
    return true;
  }

  return (
    assistantText.length >= 120 &&
    (reasoningText.includes(assistantText) ||
      assistantText.includes(reasoningText))
  );
}

export function buildAssistantActivityItems(input: {
  assistantText?: string;
  steps?: ThinkingStepRecord[];
  toolCalls?: ToolCallRecord[];
  traceParts?: TracePartRecord[];
}): AssistantActivityItem[] {
  const safeToolCalls = uniqueToolCalls(input.toolCalls);
  const stepByToolCallId = buildStepByToolCallId(input.steps);

  return (input.traceParts ?? [])
    .slice()
    .sort((left, right) => left.order - right.order)
    .flatMap((part): AssistantActivityItem[] => {
      if (part.kind === "reasoning") {
        if (
          isAssistantAnswerLikeReasoning({
            assistantText: input.assistantText,
            reasoningText: part.text,
          })
        ) {
          return [];
        }
        return [
          {
            durationMs: part.durationMs,
            id: part.id,
            key: `part:${part.id}`,
            order: part.order,
            phase: part.phase,
            text: part.text,
            tool: part.tool,
            toolCallId: part.toolCallId,
            type: "reasoning",
          },
        ];
      }

      if (part.kind === "step") {
        if (/^checking citations$/i.test(part.title.trim())) {
          return [];
        }
        const toolCallId = part.metadata?.toolCallId;

        return [
          {
            id: part.id,
            items: part.items,
            key: `part:${part.id}`,
            metadata: part.metadata,
            order: part.order,
            status: part.status,
            title: part.title,
            ...(typeof toolCallId === "string" ? { toolCallId } : {}),
            type: "step",
          },
        ];
      }

      const matchedToolCall = safeToolCalls.find(
        (toolCall) => toolCall.id === part.toolCallId,
      );
      const toolCall = buildToolCallFromPart({ matchedToolCall, part });
      return [
        {
          id: part.id,
          key: `part:${part.id}`,
          order: part.order,
          toolCall,
          toolStep: stepByToolCallId.get(part.toolCallId),
          type: "tool",
        },
      ];
    });
}
