import { resolveModelGatewayConfig } from "./config";
import { ModelGatewayAsrEndpoint } from "./endpoints/asr";
import { ModelGatewayChatEndpoint } from "./endpoints/chat";
import { ModelGatewayEmbeddingsEndpoint } from "./endpoints/embeddings";
import { ModelGatewayImagesEndpoint } from "./endpoints/images";
import { ModelGatewayRerankEndpoint } from "./endpoints/rerank";
import { ModelGatewayTtsEndpoint } from "./endpoints/tts";
import type {
  AsrTranscribeInput,
  AsrTranscribeResult,
  ChatCompleteInput,
  ChatCompleteResult,
  ChatStreamEvent,
  ChatStreamInput,
  EmbedBatchInput,
  EmbedBatchResult,
  EmbedInput,
  EmbedResult,
  ImageGenerateInput,
  ImageGenerateResult,
  ModelGateway,
  ModelGatewayConfig,
  RequestOptions,
  RerankInput,
  RerankResult,
  TtsSpeechInput,
  TtsSpeechResult,
} from "./types";

export class ModelGatewayClient implements ModelGateway {
  private readonly chatEndpoint: ModelGatewayChatEndpoint;

  private readonly embeddingsEndpoint: ModelGatewayEmbeddingsEndpoint;

  private readonly rerankEndpoint: ModelGatewayRerankEndpoint;

  private readonly asrEndpoint: ModelGatewayAsrEndpoint;

  private readonly ttsEndpoint: ModelGatewayTtsEndpoint;

  private readonly imagesEndpoint: ModelGatewayImagesEndpoint;

  constructor(config: ModelGatewayConfig) {
    const resolved = resolveModelGatewayConfig(config);
    this.chatEndpoint = new ModelGatewayChatEndpoint(resolved);
    this.embeddingsEndpoint = new ModelGatewayEmbeddingsEndpoint(resolved);
    this.rerankEndpoint = new ModelGatewayRerankEndpoint(resolved);
    this.asrEndpoint = new ModelGatewayAsrEndpoint(resolved);
    this.ttsEndpoint = new ModelGatewayTtsEndpoint(resolved);
    this.imagesEndpoint = new ModelGatewayImagesEndpoint(resolved);
  }

  readonly chat = {
    complete: async (
      input: ChatCompleteInput,
      opts?: RequestOptions,
    ): Promise<ChatCompleteResult> => this.chatEndpoint.complete(input, opts),
    stream: (
      input: ChatStreamInput,
      opts?: RequestOptions,
    ): AsyncIterable<ChatStreamEvent> => this.chatEndpoint.stream(input, opts),
  };

  readonly embeddings = {
    embed: async (
      input: EmbedInput,
      opts?: RequestOptions,
    ): Promise<EmbedResult> => this.embeddingsEndpoint.embed(input, opts),
    embedBatch: async (
      input: EmbedBatchInput,
      opts?: RequestOptions,
    ): Promise<EmbedBatchResult> => this.embeddingsEndpoint.embedBatch(input, opts),
  };

  readonly rerank = {
    rank: async (
      input: RerankInput,
      opts?: RequestOptions,
    ): Promise<RerankResult> => this.rerankEndpoint.rank(input, opts),
  };

  readonly asr = {
    transcribe: async (
      input: AsrTranscribeInput,
      opts?: RequestOptions,
    ): Promise<AsrTranscribeResult> => this.asrEndpoint.transcribe(input, opts),
  };

  readonly tts = {
    speech: async (
      input: TtsSpeechInput,
      opts?: RequestOptions,
    ): Promise<TtsSpeechResult> => this.ttsEndpoint.speech(input, opts),
  };

  readonly images = {
    generate: async (
      input: ImageGenerateInput,
      opts?: RequestOptions,
    ): Promise<ImageGenerateResult> => this.imagesEndpoint.generate(input, opts),
  };
}

export function createModelGateway(config: ModelGatewayConfig): ModelGateway {
  return new ModelGatewayClient(config);
}
