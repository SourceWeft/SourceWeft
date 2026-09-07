import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type {
  AsrTranscribeInput,
  AsrTranscribeResult,
  ChatCompleteInput,
  EmbedBatchInput,
  EmbedInput,
  ImageGenerateInput,
  ImageGenerateResult,
  ProviderKind,
  RequestOptions,
  ResolvedRequestTarget,
  RerankInput,
  RerankResult,
  TtsSpeechInput,
  TtsSpeechResult,
} from "../types";

/** Host transport, supplied by the bridge rather than by model input. */
export type AdapterRequestOptions = RequestOptions & {
  fetch?: typeof globalThis.fetch;
};

export interface ChatAdapter {
  readonly kind: ProviderKind;

  createModel(
    target: ResolvedRequestTarget,
    input: ChatCompleteInput,
    options?: AdapterRequestOptions,
  ): BaseChatModel;
}

export interface EmbeddingsAdapter {
  readonly kind: ProviderKind;

  createModel(
    target: ResolvedRequestTarget,
    input: EmbedInput | EmbedBatchInput,
    options?: AdapterRequestOptions,
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

export interface TtsTransport {
  readonly kind: ProviderKind;

  execute(input: {
    target: ResolvedRequestTarget;
    payload: TtsSpeechInput;
    options?: RequestOptions;
    fetch: typeof globalThis.fetch;
  }): Promise<TtsSpeechResult>;
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
