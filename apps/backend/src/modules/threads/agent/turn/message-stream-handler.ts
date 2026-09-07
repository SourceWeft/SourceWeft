import { hasAgentToolCapability } from "@sourceweft/agent-tool-registry";
import type { CommandSuccessCriteria } from "../..";
import type { ContentBillingPort } from "../../../content/billing-port";
import type { LlmExecutionConfig } from "../../../content/model-gateway-audit";
import type { PreparedThreadTurn } from "../..";
import type { DeepAgentTurnEvent } from "./events";
import {
  extractFinishReasonFromMessageChunk,
  extractProviderFieldsFromMessageChunk,
  extractReasoningFromMessageChunk,
  extractTextDeltasFromMessageChunk,
} from "./content";
import {
  shouldSuppressLeakedCommandSpecText,
  shouldSuppressRawToolCallText,
} from "./command-success";
import {
  promotePendingToolStreamsFromToolCalls,
  isDeepAgentsWriteTodosTool,
  extractToolCallsFromMessage,
  rememberObservedToolCalls,
} from "./tool-tracker";
import { sanitizeFilesystemToolInputForClient } from "./output-normalizer";
import type { TurnRuntime } from "./turn-runtime";
import { appendReasoningChunk } from "./thinking";

export async function* handleMessagesStreamChunk(input: {
  payload: unknown;
  commandSuccessCriteria: CommandSuccessCriteria;
  runtime: TurnRuntime;
  suppressModelReasoning: boolean;
  prepared?: PreparedThreadTurn;
  billing?: ContentBillingPort;
  llm?: LlmExecutionConfig;
  operation?: "chat.stream" | "chat.complete";
}): AsyncGenerator<DeepAgentTurnEvent> {
  const { payload, commandSuccessCriteria, runtime, suppressModelReasoning } =
    input;
  if (!Array.isArray(payload) || payload.length < 1) {
    return;
  }

  const messageChunk = payload[0];
  const messageMetadata = payload[1];
  if (isInternalModelMessage(messageMetadata)) return;
  const messageToolCalls = extractToolCallsFromMessage(messageChunk);
  rememberObservedToolCalls(runtime.observedToolCallsById, messageToolCalls);
  const promotedToolStreams = promotePendingToolStreamsFromToolCalls({
    pendingToolStreamsByRunId: runtime.pendingToolStreamsByRunId,
    resolveToolCallSequence: runtime.resolveToolCallSequence,
    toolCallOrder: runtime.toolCallOrder,
    toolCalls: messageToolCalls,
    toolCallsById: runtime.toolCallsById,
  });
  for (const promoted of promotedToolStreams) {
    runtime.toolStartedAtById.set(
      promoted.toolCallId,
      promoted.pendingStartedAt ?? Date.now(),
    );
    const clientInput = sanitizeFilesystemToolInputForClient(
      promoted.toolName,
      promoted.normalizedInput,
    );
    appendPromotedToolRenderBlock({
      toolCallId: promoted.toolCallId,
      toolName: promoted.toolName,
      runtime,
    });
    yield {
      type: "tool-call-start",
      id: promoted.toolCallId,
      tool: promoted.toolName,
      input: clientInput,
      toolCall: {
        ...promoted.currentToolCall,
        input: clientInput,
      },
    };
  }
  const nextFinishReason = extractFinishReasonFromMessageChunk(messageChunk);
  runtime.finishReason = nextFinishReason ?? runtime.finishReason;
  runtime.providerFields =
    extractProviderFieldsFromMessageChunk(messageChunk) ??
    runtime.providerFields;
  const nextReasoning =
    extractReasoningFromMessageChunk(messageChunk) ??
    extractReasoningFromMessageChunk(messageMetadata) ??
    extractReasoningFromMessageChunk(payload);
  if (nextReasoning && !suppressModelReasoning) {
    runtime.modelReasoning = appendReasoningChunk(
      runtime.modelReasoning,
      nextReasoning,
    );
    const segment = runtime.appendReasoningSegment(nextReasoning);
    runtime.renderBlocks.appendReasoning({
      id: segment.id,
      text: nextReasoning,
      durationMs: segment.durationMs,
    });
    yield {
      type: "reasoning",
      reasoning: nextReasoning,
      segment,
    };
  }

  const deltas = extractTextDeltasFromMessageChunk(messageChunk);
  for (const delta of deltas) {
    if (!delta) {
      continue;
    }
    if (
      shouldSuppressRawToolCallText({
        assistantContent: runtime.assistantContent,
        criteria: commandSuccessCriteria,
        delta,
        suppressing: runtime.suppressRawToolCallText,
      })
    ) {
      runtime.suppressRawToolCallText = true;
      continue;
    }
    if (
      shouldSuppressLeakedCommandSpecText({
        assistantContent: runtime.assistantContent,
        criteria: commandSuccessCriteria,
        delta,
        suppressing: runtime.suppressLeakedCommandSpecText,
      })
    ) {
      runtime.suppressLeakedCommandSpecText = true;
      if (runtime.hasStreamedText) {
        runtime.renderBlocks.replaceText("");
        runtime.assistantContent = "";
        runtime.hasStreamedText = false;
        runtime.hasTextSinceLastToolBoundary = false;
        yield {
          type: "text-replace",
          text: "",
        };
      }
      continue;
    }
    runtime.assistantContent += delta;
    runtime.renderBlocks.appendText(delta);
    runtime.hasStreamedText = true;
    runtime.hasTextSinceLastToolBoundary = true;
    yield {
      type: "text-delta",
      delta,
    };
  }
}

export function isInternalModelMessage(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const record = metadata as Record<string, unknown>;
  return (
    record.sourceweftInternalModel === true ||
    (Array.isArray(record.tags) &&
      record.tags.some(
        (tag) =>
          tag === "sourceweft:internal-model" ||
          tag === "langsmith:nostream" ||
          tag === "nostream",
      ))
  );
}

export function appendPromotedToolRenderBlock(input: {
  runtime: TurnRuntime;
  toolCallId: string;
  toolName: string;
}) {
  if (isDeepAgentsWriteTodosTool(input.toolName)) {
    return;
  }
  // A tool block is progress. Artifact output blocks are appended only after a
  // publish commits a concrete artifact version.
  input.runtime.renderBlocks.appendTool(input.toolCallId);
}
