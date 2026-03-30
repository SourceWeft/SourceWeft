import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  ChatMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type AIMessageFields,
  type BaseMessageFields,
  type UsageMetadata,
} from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import type {
  ChatCompleteResult,
  ChatStreamEvent,
  LiteLLMMessage,
  LiteLLMToolCall,
  UsageInfo,
} from "../types";
import { isRecord } from "../utils/object";

function stringifyMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (isRecord(item) && typeof item.text === "string") {
          return item.text;
        }
        return "";
      })
      .filter((item) => item.length > 0)
      .join("\n");
  }

  return "";
}

function convertToolCalls(value: unknown): LiteLLMToolCall[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const output: LiteLLMToolCall[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== "string") {
      continue;
    }

    let argsJson = "{}";
    if (isRecord(item.args)) {
      argsJson = JSON.stringify(item.args);
    } else if (typeof item.args === "string") {
      argsJson = item.args;
    }

    output.push({
      id: typeof item.id === "string" ? item.id : undefined,
      name: item.name,
      args: isRecord(item.args) ? item.args : undefined,
      argsJson,
    });
  }

  return output.length > 0 ? output : undefined;
}

function convertAssistantContent(
  outputText: string,
  reasoning: string | undefined,
): AIMessageFields["content"] {
  if (!reasoning) {
    return outputText;
  }

  return [
    {
      type: "reasoning",
      reasoning,
    },
    {
      type: "text",
      text: outputText,
    },
  ] as unknown as AIMessageFields["content"];
}

export function usageToLangChainUsage(
  usage: UsageInfo | undefined,
): UsageMetadata | undefined {
  if (!usage) {
    return undefined;
  }

  const usageMetadata: UsageMetadata = {
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    total_tokens: usage.totalTokens ?? 0,
  };

  const inputTokenDetails: Record<string, number> = {};
  if (usage.cacheReadTokens !== undefined) {
    inputTokenDetails.cache_read = usage.cacheReadTokens;
  }
  if (usage.cacheWriteTokens !== undefined) {
    inputTokenDetails.cache_creation = usage.cacheWriteTokens;
  }

  if (Object.keys(inputTokenDetails).length > 0) {
    usageMetadata.input_token_details = inputTokenDetails;
  }

  return usageMetadata;
}

export function liteLLMResultToAIMessage(
  result: ChatCompleteResult,
): AIMessage {
  const additionalKwargs: Record<string, unknown> = {};

  if (result.reasoning) {
    additionalKwargs.reasoning_content = result.reasoning;
  }

  if (result.providerFields) {
    additionalKwargs.provider_specific_fields = result.providerFields;
  }

  const aiMessage = new AIMessage({
    content: convertAssistantContent(result.outputText, result.reasoning),
    additional_kwargs: additionalKwargs,
    tool_calls: result.message.toolCalls?.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      args: toolCall.args ?? {},
      type: "tool_call",
    })),
    response_metadata: {
      finish_reason: result.finishReason,
      model_name: result.model,
      provider_fields: result.providerFields,
      usage: result.usage,
    },
    usage_metadata: usageToLangChainUsage(result.usage),
  } as AIMessageFields);

  return aiMessage;
}

export function streamEventToChunk(
  event: ChatStreamEvent,
): ChatGenerationChunk | null {
  if (event.type === "error") {
    return null;
  }

  if (event.type === "token") {
    const message = new AIMessageChunk({
      content: event.text,
    });
    return new ChatGenerationChunk({
      message,
      text: event.text,
    });
  }

  if (event.type === "tool_call") {
    const message = new AIMessageChunk({
      content: "",
      tool_call_chunks: [
        {
          index: 0,
          id: undefined,
          name: event.name,
          args: event.argsJson,
        },
      ],
    });
    return new ChatGenerationChunk({
      message,
      text: "",
    });
  }

  if (event.type === "reasoning") {
    const message = new AIMessageChunk({
      content: "",
      additional_kwargs: {
        reasoning_content: event.content,
      },
    });
    return new ChatGenerationChunk({
      message,
      text: "",
    });
  }

  if (event.type === "provider_fields") {
    const message = new AIMessageChunk({
      content: "",
      additional_kwargs: {
        provider_specific_fields: event.data,
      },
    });
    return new ChatGenerationChunk({
      message,
      text: "",
    });
  }

  if (event.type === "usage") {
    const message = new AIMessageChunk({
      content: "",
      usage_metadata: usageToLangChainUsage(event.usage),
    });
    return new ChatGenerationChunk({
      message,
      text: "",
    });
  }

  if (event.type === "done") {
    const message = new AIMessageChunk({
      content: "",
      response_metadata: {
        finish_reason: event.finishReason,
      },
    });
    return new ChatGenerationChunk({
      message,
      text: "",
      generationInfo: {
        finish_reason: event.finishReason,
      },
    });
  }

  return null;
}

export function baseMessagesToLiteLLMMessages(
  messages: BaseMessage[],
): LiteLLMMessage[] {
  const output: LiteLLMMessage[] = [];

  for (const message of messages) {
    if (message instanceof SystemMessage) {
      output.push({
        role: "system",
        content: stringifyMessageContent(message.content),
      });
      continue;
    }

    if (message instanceof HumanMessage) {
      output.push({
        role: "user",
        content: stringifyMessageContent(message.content),
      });
      continue;
    }

    if (message instanceof ToolMessage) {
      output.push({
        role: "tool",
        content: stringifyMessageContent(message.content),
        toolCallId: message.tool_call_id,
      });
      continue;
    }

    if (message instanceof AIMessage) {
      output.push({
        role: "assistant",
        content: stringifyMessageContent(message.content),
        toolCalls: convertToolCalls(message.tool_calls),
      });
      continue;
    }

    const messageType = message._getType();
    if (messageType === "human") {
      output.push({
        role: "user",
        content: stringifyMessageContent(
          (message as BaseMessageFields).content,
        ),
      });
      continue;
    }

    if (messageType === "ai") {
      const aiMessage = message as AIMessage;
      output.push({
        role: "assistant",
        content: stringifyMessageContent(aiMessage.content),
        toolCalls: convertToolCalls(aiMessage.tool_calls),
      });
      continue;
    }

    if (messageType === "system") {
      output.push({
        role: "system",
        content: stringifyMessageContent(
          (message as BaseMessageFields).content,
        ),
      });
      continue;
    }

    if (messageType === "tool") {
      const toolMessage = message as ChatMessage;
      output.push({
        role: "tool",
        content: stringifyMessageContent(toolMessage.content),
      });
      continue;
    }

    output.push({
      role: "user",
      content: stringifyMessageContent((message as BaseMessageFields).content),
    });
  }

  return output;
}
