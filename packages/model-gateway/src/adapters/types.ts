import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type {
  ChatCompleteInput,
  EmbedBatchInput,
  EmbedInput,
  ProviderKind,
  RequestOptions,
  ResolvedRequestTarget,
  RerankInput,
  RerankResult,
} from "../types";

export interface ChatAdapter {
  readonly kind: ProviderKind;

  createModel(
    target: ResolvedRequestTarget,
    input: ChatCompleteInput,
    options?: RequestOptions,
  ): BaseChatModel;
}

export interface EmbeddingsAdapter {
  readonly kind: ProviderKind;

  createModel(
    target: ResolvedRequestTarget,
    input: EmbedInput | EmbedBatchInput,
    options?: RequestOptions,
  ): EmbeddingsInterface;
}

export interface RerankTransport {
  readonly kind: ProviderKind;

  execute(input: {
    target: ResolvedRequestTarget;
    payload: RerankInput;
    options?: RequestOptions;
    fetch: typeof globalThis.fetch;
  }): Promise<RerankResult>;
}
