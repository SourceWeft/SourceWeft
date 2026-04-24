import { resolveModelGatewayConfig } from "./config";
import { ModelGatewayChatEndpoint } from "./endpoints/chat";
import { ModelGatewayEmbeddingsEndpoint } from "./endpoints/embeddings";
import { ModelGatewayRerankEndpoint } from "./endpoints/rerank";
import type {
  ChatCompleteInput,
  ChatCompleteResult,
  ChatStreamEvent,
  ChatStreamInput,
  EmbedBatchInput,
  EmbedBatchResult,
  EmbedInput,
  EmbedResult,
  ModelGateway,
  ModelGatewayConfig,
  RequestOptions,
  RerankInput,
  RerankResult,
} from "./types";

export class ModelGatewayClient implements ModelGateway {
  private readonly chatEndpoint: ModelGatewayChatEndpoint;

  private readonly embeddingsEndpoint: ModelGatewayEmbeddingsEndpoint;

  private readonly rerankEndpoint: ModelGatewayRerankEndpoint;

  constructor(config: ModelGatewayConfig) {
    const resolved = resolveModelGatewayConfig(config);
    this.chatEndpoint = new ModelGatewayChatEndpoint(resolved);
    this.embeddingsEndpoint = new ModelGatewayEmbeddingsEndpoint(resolved);
    this.rerankEndpoint = new ModelGatewayRerankEndpoint(resolved);
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
}

export function createModelGateway(config: ModelGatewayConfig): ModelGateway {
  return new ModelGatewayClient(config);
}
