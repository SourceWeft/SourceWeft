import type { AsrLimits } from "../asr/types";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type {
  AsrTranscribeInput,
  AsrTranscribeResult,
  ChatCompleteInput,
  EmbedBatchInput,
  EmbedInput,
  GatewayLogger,
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
  /** Where SDK-level retries report each failed attempt. */
  retryLog?: {
    logger: GatewayLogger;
    provider: string;
    providerModel: string;
  };
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
  /** What this provider takes in one request, for the given target. */
  limits(target: ResolvedRequestTarget): AsrLimits;

  execute(input: {
    target: ResolvedRequestTarget;
    payload: AsrTranscribeInput;
    options?: RequestOptions;
    fetch: typeof globalThis.fetch;
  }): Promise<AsrTranscribeResult>;
}

export interface TtsTransport {
  readonly kind: ProviderKind;

  /**
   * Formats this provider can synthesize, most preferred first. Omitted when
   * the provider takes the OpenAI-style `response_format` as given. A request
   * for a format outside the list is synthesized in the first one and
   * converted by the host's transcoder.
   */
  readonly outputFormats?: readonly string[];

  /**
   * Voice ids the target's model accepts, when it has a closed list. Returns
   * undefined when the list is not known, and the voice is then passed through
   * as given. A request naming a voice outside the list is rejected before
   * the provider is called: providers answer an unknown voice with an opaque
   * server error, which callers cannot tell from an outage.
   */
  voices?(target: ResolvedRequestTarget): readonly string[] | undefined;

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
