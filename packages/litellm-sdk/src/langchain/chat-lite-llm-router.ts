import type { BaseMessage } from "@langchain/core/messages";
import type { ChatGenerationChunk } from "@langchain/core/outputs";
import type {
  ChatCompleteInput,
  ChatStreamInput,
  ModelAlias,
  RequestOptions,
} from "../types";
import { LiteLLMRouter } from "../router/litellm-router";
import {
  ChatLiteLLM,
  type ChatLiteLLMCallOptions,
  type ChatLiteLLMParams,
} from "./chat-lite-llm";

export interface ChatLiteLLMRouterParams
  extends Omit<ChatLiteLLMParams, "client" | "model"> {
  router: LiteLLMRouter;
  model?: ModelAlias;
}

export class ChatLiteLLMRouter<
  CallOptions extends ChatLiteLLMCallOptions = ChatLiteLLMCallOptions,
> extends ChatLiteLLM<CallOptions> {
  private readonly router: LiteLLMRouter;

  constructor(fields: ChatLiteLLMRouterParams) {
    super({
      ...fields,
      model: fields.model ?? "chat-default",
      client: undefined,
    });

    this.router = fields.router;
  }

  override _llmType(): string {
    return "litellm-router";
  }

  protected override async completeWithClient(
    input: ChatCompleteInput,
    options: this["ParsedCallOptions"],
  ) {
    const { model: _ignoredModel, ...rest } = input;
    return this.router.chatComplete(rest, options as RequestOptions);
  }

  protected override streamWithClient(
    input: ChatStreamInput,
    options: this["ParsedCallOptions"],
  ) {
    const { model: _ignoredModel, ...rest } = input;
    return this.router.chatStream(rest, options as RequestOptions);
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: Parameters<
      ChatLiteLLM<CallOptions>["_streamResponseChunks"]
    >[2],
  ): AsyncGenerator<ChatGenerationChunk> {
    yield* super._streamResponseChunks(messages, options, runManager);
  }
}
