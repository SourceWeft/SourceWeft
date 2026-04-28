import type { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import { normalizeGatewayError, toGatewayErrorData } from "../errors";
import { normalizeUsage } from "../normalize/usage";
import { createChatModel, toLangChainMessages } from "./utils";
import type {
  ChatCompleteInput,
  ChatCompleteResult,
  ChatStreamEvent,
  ResolvedModelGatewayConfig,
  ResolvedRequestTarget,
  RequestOptions,
} from "../types";

function extractResponseMetadata(raw: { response_metadata?: unknown }) {
  return raw.response_metadata && typeof raw.response_metadata === "object"
    ? (raw.response_metadata as Record<string, unknown>)
    : undefined;
}

function extractFinishReason(responseMetadata: Record<string, unknown> | undefined) {
  if (typeof responseMetadata?.finish_reason === "string") {
    return responseMetadata.finish_reason;
  }

  if (typeof responseMetadata?.finishReason === "string") {
    return responseMetadata.finishReason;
  }

  return undefined;
}

function extractUsage(input: {
  usageMetadata?: unknown;
  responseMetadata: Record<string, unknown> | undefined;
}) {
  if (input.usageMetadata) {
    return input.usageMetadata;
  }

  const responseMetadata = input.responseMetadata;
  if (!responseMetadata) {
    return undefined;
  }

  if (responseMetadata.usage && typeof responseMetadata.usage === "object") {
    return responseMetadata.usage;
  }

  if (
    responseMetadata.tokenUsage &&
    typeof responseMetadata.tokenUsage === "object"
  ) {
    return responseMetadata.tokenUsage;
  }

  return undefined;
}

function extractReasoning(responseMetadata: Record<string, unknown> | undefined) {
  if (typeof responseMetadata?.reasoning_content === "string") {
    return responseMetadata.reasoning_content;
  }

  const reasoning = responseMetadata?.reasoning;
  if (
    reasoning &&
    typeof reasoning === "object" &&
    typeof (reasoning as Record<string, unknown>).content === "string"
  ) {
    return (reasoning as Record<string, unknown>).content as string;
  }

  return undefined;
}

export async function runBridgeChatComplete(input: {
  config: ResolvedModelGatewayConfig;
  target: ResolvedRequestTarget;
  payload: ChatCompleteInput;
  options?: RequestOptions;
}): Promise<ChatCompleteResult> {
  try {
    const model = createChatModel(input);
    const rawMessage = (await model.invoke(
      toLangChainMessages(input.payload.messages),
    )) as AIMessage;
    const responseMetadata = extractResponseMetadata(rawMessage);

    return {
      id: typeof rawMessage.id === "string" ? rawMessage.id : undefined,
      model:
        typeof responseMetadata?.model === "string"
          ? responseMetadata.model
          : input.target.providerModel,
      usage: normalizeUsage(
        extractUsage({
          usageMetadata: rawMessage.usage_metadata,
          responseMetadata,
        }),
      ),
      finishReason: extractFinishReason(responseMetadata),
      reasoning: extractReasoning(responseMetadata),
      providerFields: responseMetadata,
      provider: input.target.provider,
      providerModel: input.target.providerModel,
      routeDecision: input.target.routeDecision,
      traceId: input.options?.traceId,
      raw: rawMessage,
    };
  } catch (error) {
    throw normalizeGatewayError(error);
  }
}

export async function* runBridgeChatStream(input: {
  config: ResolvedModelGatewayConfig;
  target: ResolvedRequestTarget;
  payload: ChatCompleteInput;
  options?: RequestOptions;
}): AsyncGenerator<ChatStreamEvent> {
  try {
    const payload = input.payload.stream
      ? input.payload
      : {
          ...input.payload,
          stream: true,
        };

    const model = createChatModel({
      ...input,
      payload,
    });
    const stream = await model.stream(toLangChainMessages(payload.messages));
    let usage = undefined;
    let finishReason: string | undefined;
    let reasoning: string | undefined;
    let providerFields: Record<string, unknown> | undefined;

    for await (const chunk of stream as AsyncIterable<AIMessageChunk>) {
      const responseMetadata = extractResponseMetadata(chunk);
      usage =
        normalizeUsage(
          extractUsage({
            usageMetadata: chunk.usage_metadata,
            responseMetadata,
          }),
        ) ?? usage;
      finishReason = extractFinishReason(responseMetadata) ?? finishReason;
      reasoning = extractReasoning(responseMetadata) ?? reasoning;
      providerFields = responseMetadata ?? providerFields;

      yield { type: "chunk", chunk };
    }

    yield {
      type: "metadata",
      metadata: {
        usage,
        finishReason,
        reasoning,
        providerFields,
        routeDecision: input.target.routeDecision,
        traceId: input.options?.traceId,
      },
    };
  } catch (error) {
    yield {
      type: "error",
      error: toGatewayErrorData(error),
    };
  }
}
