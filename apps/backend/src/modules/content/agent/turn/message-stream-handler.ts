import type { CommandSuccessCriteria } from "../../threads";
import type { DeepAgentTurnEvent } from "./events";
import {
  extractFinishReasonFromMessageChunk,
  extractProviderFieldsFromMessageChunk,
  extractReasoningFromMessageChunk,
  extractTextDeltasFromMessageChunk,
  extractUsageFromMessageChunk,
} from "./content";
import {
  shouldSuppressLeakedCommandSpecText,
  shouldSuppressRawToolCallText,
} from "./command-success";
import {
  extractToolCallsFromMessage,
  rememberObservedToolCalls,
} from "./tool-tracker";
import { addUsage } from "./usage";
import type { TurnRuntime } from "./turn-runtime";
import { appendReasoningChunk } from "./thinking";

export async function* handleMessagesStreamChunk(input: {
  payload: unknown;
  commandSuccessCriteria: CommandSuccessCriteria;
  runtime: TurnRuntime;
  suppressModelReasoning: boolean;
}): AsyncGenerator<DeepAgentTurnEvent> {
  const { payload, commandSuccessCriteria, runtime, suppressModelReasoning } =
    input;
  if (!Array.isArray(payload) || payload.length < 1) {
    return;
  }

  const messageChunk = payload[0];
  const messageMetadata = payload[1];
  rememberObservedToolCalls(
    runtime.observedToolCallsById,
    extractToolCallsFromMessage(messageChunk),
  );
  runtime.usage = addUsage(
    runtime.usage,
    extractUsageFromMessageChunk(messageChunk),
  );
  runtime.finishReason =
    extractFinishReasonFromMessageChunk(messageChunk) ?? runtime.finishReason;
  runtime.providerFields =
    extractProviderFieldsFromMessageChunk(messageChunk) ?? runtime.providerFields;
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
