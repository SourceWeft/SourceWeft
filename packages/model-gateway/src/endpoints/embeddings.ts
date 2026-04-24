import { resolveRequestTarget } from "../config";
import { normalizeGatewayError } from "../errors";
import { runBridgeEmbedding, runBridgeEmbeddingBatch } from "../bridge/embeddings";
import type {
  EmbedBatchInput,
  EmbedBatchResult,
  EmbedInput,
  EmbedResult,
  RequestOptions,
  ResolvedModelGatewayConfig,
} from "../types";

export class ModelGatewayEmbeddingsEndpoint {
  constructor(private readonly config: ResolvedModelGatewayConfig) {}

  async embed(
    input: EmbedInput,
    options?: RequestOptions,
  ): Promise<EmbedResult> {
    const target = await resolveRequestTarget(this.config, input);
    try {
      return await runBridgeEmbedding({
        config: this.config,
        target,
        payload: input,
        options,
      });
    } catch (error) {
      throw normalizeGatewayError(error);
    }
  }

  async embedBatch(
    input: EmbedBatchInput,
    options?: RequestOptions,
  ): Promise<EmbedBatchResult> {
    const target = await resolveRequestTarget(this.config, input);
    try {
      return await runBridgeEmbeddingBatch({
        config: this.config,
        target,
        payload: input,
        options,
      });
    } catch (error) {
      throw normalizeGatewayError(error);
    }
  }
}
