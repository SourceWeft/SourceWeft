import { assertModelAliasAllowed } from "../config";
import { toUnifiedError } from "../errors";
import { buildStructuredOutputRequest } from "../compat/structured-output";
import { normalizeToolChoice } from "../compat/tool-choice";
import { buildTracingMetadata } from "../middleware/tracing";
import {
  normalizeChatCompleteResponse,
  normalizeChatStreamChunk,
  toWireMessages,
} from "../normalize/messages";
import { requestJson, requestStream } from "../transport/http";
import { parseSSE } from "../transport/sse";
import type {
  ChatCompleteInput,
  ChatCompleteResult,
  ChatStreamEvent,
  ChatStreamInput,
  RequestOptions,
  ResolvedLiteLLMClientConfig,
} from "../types";
import {
  compactObject,
  deepCompact,
  isRecord,
  safeJsonParse,
} from "../utils/object";

function buildChatBody(
  config: ResolvedLiteLLMClientConfig,
  input: ChatCompleteInput,
  options: RequestOptions | undefined,
): Record<string, unknown> {
  assertModelAliasAllowed(input.model, config);

  const structuredOutput = buildStructuredOutputRequest(input.structuredOutput);

  return deepCompact(
    compactObject({
      model: input.model,
      messages: toWireMessages(input.messages),
      temperature: input.temperature,
      top_p: input.topP,
      max_tokens: input.maxTokens,
      stop: input.stop,
      tools: input.tools,
      tool_choice: normalizeToolChoice(input.toolChoice),
      response_format: input.responseFormat ?? structuredOutput.responseFormat,
      metadata: buildTracingMetadata(
        input.metadata,
        options,
        config.requestMetadata,
      ),
      ...structuredOutput.extraBody,
      ...input.extraBody,
    }),
  ) as Record<string, unknown>;
}

export class LiteLLMChatEndpoint {
  constructor(private readonly config: ResolvedLiteLLMClientConfig) {}

  async complete(
    input: ChatCompleteInput,
    options?: RequestOptions,
  ): Promise<ChatCompleteResult> {
    const body = buildChatBody(this.config, input, options);

    const raw = await requestJson<Record<string, unknown>>(this.config, {
      path: "/chat/completions",
      method: "POST",
      body,
      options,
    });

    return normalizeChatCompleteResponse(raw, input.model);
  }

  async *stream(
    input: ChatStreamInput,
    options?: RequestOptions,
  ): AsyncGenerator<ChatStreamEvent> {
    const body = buildChatBody(this.config, input, options);
    body.stream = true;

    let terminalEmitted = false;
    let finishReason: string | undefined;

    try {
      const response = await requestStream(this.config, {
        path: "/chat/completions",
        method: "POST",
        body,
        options,
      });

      for await (const event of parseSSE(response)) {
        if (event.data === "[DONE]") {
          yield {
            type: "done",
            finishReason,
          };
          terminalEmitted = true;
          break;
        }

        const parsed = safeJsonParse(event.data);
        if (!isRecord(parsed)) {
          continue;
        }

        const chunk = normalizeChatStreamChunk(parsed);
        if (chunk.finishReason) {
          finishReason = chunk.finishReason;
        }

        if (chunk.providerFields) {
          yield {
            type: "provider_fields",
            data: chunk.providerFields,
          };
        }

        if (chunk.reasoning) {
          yield {
            type: "reasoning",
            content: chunk.reasoning,
          };
        }

        if (chunk.toolCalls) {
          for (const toolCall of chunk.toolCalls) {
            yield {
              type: "tool_call",
              name: toolCall.name,
              argsJson:
                toolCall.argsJson ?? JSON.stringify(toolCall.args ?? {}),
            };
          }
        }

        if (chunk.token) {
          yield {
            type: "token",
            text: chunk.token,
          };
        }

        if (chunk.usage) {
          yield {
            type: "usage",
            usage: chunk.usage,
          };
        }
      }
    } catch (error) {
      yield {
        type: "error",
        error: toUnifiedError(error),
      };
      terminalEmitted = true;
    }

    if (!terminalEmitted) {
      yield {
        type: "done",
        finishReason,
      };
    }
  }
}
