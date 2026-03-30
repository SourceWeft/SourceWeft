import type {
  ChatCompleteResult,
  LiteLLMMessage,
  LiteLLMToolCall,
} from "../types";
import { safeJsonParse, isRecord } from "../utils/object";
import { extractProviderFields } from "./provider-fields";
import { normalizeUsage } from "./usage";

function normalizeContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (!isRecord(item)) {
          return "";
        }

        if (typeof item.text === "string") {
          return item.text;
        }

        if (typeof item.content === "string") {
          return item.content;
        }

        return "";
      })
      .filter((item) => item.length > 0);

    return parts.join("\n");
  }

  return "";
}

function normalizeToolCalls(input: unknown): LiteLLMToolCall[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }

  const toolCalls: LiteLLMToolCall[] = [];
  for (const item of input) {
    if (!isRecord(item)) {
      continue;
    }

    let name = "";
    let argsJson = "{}";

    if (isRecord(item.function)) {
      if (typeof item.function.name === "string") {
        name = item.function.name;
      }
      if (typeof item.function.arguments === "string") {
        argsJson = item.function.arguments;
      } else if (isRecord(item.function.arguments)) {
        argsJson = JSON.stringify(item.function.arguments);
      }
    }

    if (!name) {
      continue;
    }

    const argsParsed = safeJsonParse(argsJson);
    toolCalls.push({
      id: typeof item.id === "string" ? item.id : undefined,
      name,
      args: isRecord(argsParsed) ? argsParsed : undefined,
      argsJson,
    });
  }

  return toolCalls.length > 0 ? toolCalls : undefined;
}

function extractReasoningContent(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }

    if (
      typeof candidate.reasoning_content === "string" &&
      candidate.reasoning_content.trim().length > 0
    ) {
      return candidate.reasoning_content;
    }

    if (
      isRecord(candidate.reasoning) &&
      typeof candidate.reasoning.content === "string" &&
      candidate.reasoning.content.trim().length > 0
    ) {
      return candidate.reasoning.content;
    }
  }

  return undefined;
}

function normalizeAssistantMessage(
  message: Record<string, unknown>,
  providerFields?: Record<string, unknown>,
): LiteLLMMessage {
  const normalized: LiteLLMMessage = {
    role: "assistant",
    content: normalizeContent(message.content),
  };

  const reasoning = extractReasoningContent(message, providerFields);
  if (reasoning) {
    normalized.reasoningContent = reasoning;
  }

  const toolCalls = normalizeToolCalls(message.tool_calls);
  if (toolCalls) {
    normalized.toolCalls = toolCalls;
  }

  if (providerFields) {
    normalized.providerFields = providerFields;
  }

  return normalized;
}

export function toWireMessages(
  messages: LiteLLMMessage[],
): Array<Record<string, unknown>> {
  return messages.map((message) => {
    const wireMessage: Record<string, unknown> = {
      role: message.role,
      content: message.content,
    };

    if (message.name) {
      wireMessage.name = message.name;
    }

    if (message.role === "tool" && message.toolCallId) {
      wireMessage.tool_call_id = message.toolCallId;
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      wireMessage.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: call.argsJson ?? JSON.stringify(call.args ?? {}),
        },
      }));
    }

    return wireMessage;
  });
}

export function normalizeChatCompleteResponse(
  raw: Record<string, unknown>,
  requestedModel: string,
): ChatCompleteResult {
  const firstChoice =
    Array.isArray(raw.choices) &&
    raw.choices.length > 0 &&
    isRecord(raw.choices[0])
      ? raw.choices[0]
      : undefined;

  const responseMessage =
    firstChoice && isRecord(firstChoice.message) ? firstChoice.message : {};

  const providerFields = extractProviderFields(raw, responseMessage);
  const message = normalizeAssistantMessage(responseMessage, providerFields);

  const model = typeof raw.model === "string" ? raw.model : requestedModel;
  const finishReason =
    firstChoice && typeof firstChoice.finish_reason === "string"
      ? firstChoice.finish_reason
      : undefined;

  return {
    id: typeof raw.id === "string" ? raw.id : undefined,
    model,
    outputText: message.content,
    message,
    usage: normalizeUsage(raw.usage),
    finishReason,
    reasoning: message.reasoningContent,
    providerFields,
    raw,
  };
}

export interface NormalizedStreamChunk {
  token?: string;
  usage?: ReturnType<typeof normalizeUsage>;
  finishReason?: string;
  reasoning?: string;
  providerFields?: Record<string, unknown>;
  toolCalls?: LiteLLMToolCall[];
}

export function normalizeChatStreamChunk(
  rawChunk: Record<string, unknown>,
): NormalizedStreamChunk {
  const firstChoice =
    Array.isArray(rawChunk.choices) &&
    rawChunk.choices.length > 0 &&
    isRecord(rawChunk.choices[0])
      ? rawChunk.choices[0]
      : undefined;

  const delta =
    firstChoice && isRecord(firstChoice.delta) ? firstChoice.delta : undefined;

  const token =
    delta && typeof delta.content === "string" ? delta.content : undefined;

  const toolCalls = normalizeToolCalls(delta?.tool_calls);
  const providerFields = extractProviderFields(rawChunk, delta);
  const reasoning = extractReasoningContent(delta, rawChunk, providerFields);

  const finishReason =
    firstChoice && typeof firstChoice.finish_reason === "string"
      ? firstChoice.finish_reason
      : undefined;

  return {
    token,
    toolCalls,
    usage: normalizeUsage(rawChunk.usage),
    finishReason,
    reasoning,
    providerFields,
  };
}
