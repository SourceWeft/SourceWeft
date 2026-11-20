import {
  ChatGoogleGenerativeAI,
  EmptyContentError,
  type GoogleGenerativeAIChatInput,
} from "@langchain/google-genai";
import { ModelGatewayError } from "../errors";
import type { ChatAdapter } from "./types";
import { GatewayCaller } from "./gateway-caller";

/**
 * A non-streaming Gemini reply with no content — a safety or recitation
 * block, a rejected prompt, an output budget spent before any content — is
 * raised by the SDK wrapper as `EmptyContentError`. It carries no HTTP status,
 * so unclassified the gateway would read it as an upstream fault, retry it and
 * send the same request to every other target in the route. It is Gemini's
 * answer to this request, so it fails once, as a request error.
 *
 * Streaming is not affected: the wrapper skips a contentless chunk there.
 */
class GatewayChatGoogleGenerativeAI extends ChatGoogleGenerativeAI {
  constructor(
    fields: GoogleGenerativeAIChatInput,
    private readonly gatewayProvider: string,
  ) {
    super(fields);
  }

  override async _generate(
    ...args: Parameters<ChatGoogleGenerativeAI["_generate"]>
  ) {
    try {
      return await super._generate(...args);
    } catch (error) {
      if (!EmptyContentError.isInstance(error)) throw error;
      throw new ModelGatewayError({
        code: "BAD_REQUEST",
        message: error.message,
        retryable: false,
        provider: this.gatewayProvider,
        metadata: {
          reason: "empty_content",
          ...(error.finishReason !== undefined
            ? { finishReason: error.finishReason }
            : {}),
          ...(error.blockReason !== undefined
            ? { blockReason: error.blockReason }
            : {}),
        },
        cause: error,
      });
    }
  }
}

export class GeminiChatAdapter implements ChatAdapter {
  readonly kind = "gemini" as const;

  createModel(
    target: Parameters<ChatAdapter["createModel"]>[0],
    input: Parameters<ChatAdapter["createModel"]>[1],
    options?: Parameters<ChatAdapter["createModel"]>[2],
  ) {
    const model = new GatewayChatGoogleGenerativeAI(
      {
        model: target.providerModel,
        temperature: input.temperature,
        topP: input.topP,
        maxOutputTokens: input.maxTokens,
        apiKey: target.apiKey,
        baseUrl: target.baseUrl,
        customHeaders: target.defaultHeaders,
        fetch: options?.fetch,
        streaming: input.stream ?? false,
      },
      target.provider,
    );
    model.caller = new GatewayCaller(options);
    return model;
  }
}
