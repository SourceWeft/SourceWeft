import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type {
  ChatCompleteInput,
  AsrTranscribeInput,
  AsrTranscribeResult,
  EmbedBatchInput,
  EmbedInput,
  ImageGenerateInput,
  ImageGenerateResult,
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

export interface AsrTransport {
  readonly kind: ProviderKind;
  readonly supportedAudioFormats: readonly string[];

  execute(input: {
    target: ResolvedRequestTarget;
    payload: AsrTranscribeInput;
    options?: RequestOptions;
    fetch: typeof globalThis.fetch;
  }): Promise<AsrTranscribeResult>;
}

export interface ImageGenerationTransport {
  readonly kind: ProviderKind;

  execute(input: {
    target: ResolvedRequestTarget;
    payload: ImageGenerateInput;
    options?: RequestOptions;
    fetch: typeof globalThis.fetch;
  }): Promise<ImageGenerateResult>;
}
