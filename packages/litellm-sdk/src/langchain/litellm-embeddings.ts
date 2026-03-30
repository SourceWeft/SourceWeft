import { Embeddings, type EmbeddingsParams } from "@langchain/core/embeddings";
import { createLiteLLMSDK } from "../client";
import type {
  EmbedBatchInput,
  EmbedBatchResult,
  EmbedInput,
  EmbedResult,
  LiteLLMClientConfig,
  LiteLLMSDK,
  ModelAlias,
  RequestOptions,
} from "../types";

export interface LiteLLMEmbeddingsParams extends EmbeddingsParams {
  model?: ModelAlias;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
  dimensions?: number;
  encodingFormat?: "float" | "base64";
  documentInputType?: string;
  queryInputType?: string;
  allowNonDefaultAliases?: boolean;
  allowedModelAliases?: readonly string[];
  requestMetadata?: Record<string, unknown>;
  client?: LiteLLMSDK;
}

export class LiteLLMEmbeddings extends Embeddings {
  readonly model: ModelAlias;

  readonly dimensions?: number;

  readonly encodingFormat?: "float" | "base64";

  readonly documentInputType?: string;

  readonly queryInputType?: string;

  protected client: LiteLLMSDK;

  constructor(fields?: LiteLLMEmbeddingsParams) {
    const fieldsWithDefaults = {
      maxConcurrency: 2,
      ...(fields ?? {}),
    };

    super(fieldsWithDefaults);

    this.model = fieldsWithDefaults.model ?? "embed-default";
    this.dimensions = fieldsWithDefaults.dimensions;
    this.encodingFormat = fieldsWithDefaults.encodingFormat;
    this.documentInputType = fieldsWithDefaults.documentInputType;
    this.queryInputType = fieldsWithDefaults.queryInputType;

    this.client =
      fieldsWithDefaults.client ??
      createLiteLLMSDK({
        baseUrl: fieldsWithDefaults.baseUrl ?? "http://localhost:4000",
        apiKey: fieldsWithDefaults.apiKey,
        timeoutMs: fieldsWithDefaults.timeoutMs,
        maxRetries: fieldsWithDefaults.maxRetries,
        allowNonDefaultAliases: fieldsWithDefaults.allowNonDefaultAliases,
        allowedModelAliases: fieldsWithDefaults.allowedModelAliases,
        requestMetadata: fieldsWithDefaults.requestMetadata,
      } satisfies LiteLLMClientConfig);
  }

  protected embedWithClient(input: EmbedInput, options?: RequestOptions) {
    return this.client.embeddings.embed(input, options);
  }

  protected embedBatchWithClient(
    input: EmbedBatchInput,
    options?: RequestOptions,
  ) {
    return this.client.embeddings.embedBatch(input, options);
  }

  protected toEmbedInput(text: string): EmbedInput {
    return {
      model: this.model,
      text,
      inputType: this.queryInputType,
      dimensions: this.dimensions,
      encodingFormat: this.encodingFormat,
    };
  }

  protected toEmbedBatchInput(texts: string[]): EmbedBatchInput {
    return {
      model: this.model,
      texts,
      inputType: this.documentInputType,
      dimensions: this.dimensions,
      encodingFormat: this.encodingFormat,
    };
  }

  async embedQuery(text: string): Promise<number[]> {
    const result: EmbedResult = await this.embedWithClient(
      this.toEmbedInput(text),
    );
    return result.embedding;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const result: EmbedBatchResult = await this.embedBatchWithClient(
      this.toEmbedBatchInput(texts),
    );
    return result.embeddings;
  }
}
