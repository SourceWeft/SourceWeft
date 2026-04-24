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
  return typeof responseMetadata?.finish_reason === "string"
    ? responseMetadata.finish_reason
    : typeof responseMetadata?.finishReason === "string"
      ? responseMetadata.finishReason
      : undefined;
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
        rawMessage.usage_metadata ??
          (responseMetadata?.tokenUsage as Record<string, unknown> | undefined) ??
          (responseMetadata?.usage as Record<string, unknown> | undefined),
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
          chunk.usage_metadata ??
            (responseMetadata?.tokenUsage as Record<string, unknown> | undefined) ??
            (responseMetadata?.usage as Record<string, unknown> | undefined),
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
