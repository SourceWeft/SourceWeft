import { resolveLiteLLMConfig } from "./config";
import { LiteLLMChatEndpoint } from "./endpoints/chat";
import { LiteLLMEmbeddingsEndpoint } from "./endpoints/embeddings";
import { LiteLLMRerankEndpoint } from "./endpoints/rerank";
import type {
  LiteLLMClientConfig,
  LiteLLMSDK,
  RequestOptions,
  ChatCompleteInput,
  ChatCompleteResult,
  ChatStreamInput,
  ChatStreamEvent,
  EmbedInput,
  EmbedResult,
  EmbedBatchInput,
  EmbedBatchResult,
  RerankInput,
  RerankResult,
} from "./types";

export class LiteLLMClient implements LiteLLMSDK {
  private readonly chatEndpoint: LiteLLMChatEndpoint;

  private readonly embeddingsEndpoint: LiteLLMEmbeddingsEndpoint;

  private readonly rerankEndpoint: LiteLLMRerankEndpoint;

  constructor(config: LiteLLMClientConfig) {
    const resolved = resolveLiteLLMConfig(config);
    this.chatEndpoint = new LiteLLMChatEndpoint(resolved);
    this.embeddingsEndpoint = new LiteLLMEmbeddingsEndpoint(resolved);
    this.rerankEndpoint = new LiteLLMRerankEndpoint(resolved);
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
    ): Promise<EmbedBatchResult> =>
      this.embeddingsEndpoint.embedBatch(input, opts),
  };

  readonly rerank = {
    rank: async (
      input: RerankInput,
      opts?: RequestOptions,
    ): Promise<RerankResult> => this.rerankEndpoint.rank(input, opts),
  };
}

export function createLiteLLMSDK(config: LiteLLMClientConfig): LiteLLMSDK {
  return new LiteLLMClient(config);
}
