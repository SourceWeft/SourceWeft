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

export interface ChatAdapter {
  readonly kind: ProviderKind;

  /**
   * The adapter's thinking-mode "off" is a hard provider-level disable (e.g.
   * DeepSeek's `thinking: {type: "disabled"}`), not a best-effort hint. Only
   * behind such a guarantee may a `forcedToolChoiceBlockedByThinking` model be
   * given a forced `tool_choice`: through a best-effort channel (OpenRouter's
   * `reasoning.effort: "none"` across heterogeneous upstreams) the upstream may
   * still be thinking, and the forced choice would 400.
   */
  readonly guaranteesThinkingDisable?: boolean;

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
