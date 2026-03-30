import { LiteLLMError, isRetryableError } from "../errors";
import type {
  ChatCompleteInput,
  ChatCompleteResult,
  ChatStreamEvent,
  ChatStreamInput,
  EmbedBatchInput,
  EmbedBatchResult,
  EmbedInput,
  EmbedResult,
  LiteLLMRouterOptions,
  LiteLLMSDK,
  ModelAlias,
  RequestOptions,
  RerankInput,
  RerankResult,
  RouterStrategy,
} from "../types";

function reorderRoundRobin(
  models: readonly ModelAlias[],
  cursor: number,
): ModelAlias[] {
  if (models.length === 0) {
    return [];
  }

  const start = cursor % models.length;
  const output: ModelAlias[] = [];

  for (let index = 0; index < models.length; index += 1) {
    const model = models[(start + index) % models.length];
    if (model) {
      output.push(model);
    }
  }

  return output;
}

function reorderRandom(models: readonly ModelAlias[]): ModelAlias[] {
  return [...models].sort(() => Math.random() - 0.5);
}

function orderModels(
  models: readonly ModelAlias[],
  strategy: RouterStrategy,
  cursor: number,
): ModelAlias[] {
  if (strategy === "random") {
    return reorderRandom(models);
  }
  return reorderRoundRobin(models, cursor);
}

export class LiteLLMRouter {
  private readonly strategy: RouterStrategy;

  private readonly maxAttemptsPerRequest: number;

  private chatCursor = 0;

  private embeddingCursor = 0;

  private rerankCursor = 0;

  constructor(
    private readonly sdk: LiteLLMSDK,
    private readonly options: LiteLLMRouterOptions,
  ) {
    this.strategy = options.strategy ?? "round_robin";
    this.maxAttemptsPerRequest = options.maxAttemptsPerRequest ?? 2;
  }

  private getChatModels(): readonly ModelAlias[] {
    return this.options.chatModels;
  }

  private getEmbeddingModels(): readonly ModelAlias[] {
    return this.options.embeddingModels ?? ["embed-default"];
  }

  private getRerankModels(): readonly ModelAlias[] {
    return this.options.rerankModels ?? ["rerank-default"];
  }

  private throwIfMissingModels(models: readonly ModelAlias[], kind: string) {
    if (models.length === 0) {
      throw new LiteLLMError({
        code: "BAD_REQUEST",
        message: `LiteLLM router requires at least one ${kind} model alias`,
        retryable: false,
      });
    }
  }

  private selectModels(kind: "chat" | "embedding" | "rerank"): ModelAlias[] {
    if (kind === "chat") {
      const models = this.getChatModels();
      this.throwIfMissingModels(models, "chat");
      const ordered = orderModels(models, this.strategy, this.chatCursor);
      this.chatCursor += 1;
      return ordered;
    }

    if (kind === "embedding") {
      const models = this.getEmbeddingModels();
      this.throwIfMissingModels(models, "embedding");
      const ordered = orderModels(models, this.strategy, this.embeddingCursor);
      this.embeddingCursor += 1;
      return ordered;
    }

    const models = this.getRerankModels();
    this.throwIfMissingModels(models, "rerank");
    const ordered = orderModels(models, this.strategy, this.rerankCursor);
    this.rerankCursor += 1;
    return ordered;
  }

  private async withFallback<T>(
    models: readonly ModelAlias[],
    execute: (model: ModelAlias) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    const maxAttempts = Math.min(this.maxAttemptsPerRequest, models.length);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const model = models[attempt];
      if (!model) {
        continue;
      }

      try {
        return await execute(model);
      } catch (error) {
        lastError = error;
        if (!isRetryableError(error) || attempt >= maxAttempts - 1) {
          throw error;
        }
      }
    }

    throw lastError;
  }

  async chatComplete(
    input: Omit<ChatCompleteInput, "model"> & { model?: ModelAlias },
    options?: RequestOptions,
  ): Promise<ChatCompleteResult> {
    if (input.model) {
      return this.sdk.chat.complete(
        {
          ...input,
          model: input.model,
        },
        options,
      );
    }

    const models = this.selectModels("chat");
    return this.withFallback(models, async (model) =>
      this.sdk.chat.complete(
        {
          ...input,
          model,
        },
        options,
      ),
    );
  }

  chatStream(
    input: Omit<ChatStreamInput, "model"> & { model?: ModelAlias },
    options?: RequestOptions,
  ): AsyncIterable<ChatStreamEvent> {
    const selectedModel =
      input.model ?? this.selectModels("chat")[0] ?? "chat-default";
    return this.sdk.chat.stream(
      {
        ...input,
        model: selectedModel,
      },
      options,
    );
  }

  async embed(
    input: Omit<EmbedInput, "model"> & { model?: ModelAlias },
    options?: RequestOptions,
  ): Promise<EmbedResult> {
    if (input.model) {
      return this.sdk.embeddings.embed(
        {
          ...input,
          model: input.model,
        },
        options,
      );
    }

    const models = this.selectModels("embedding");
    return this.withFallback(models, async (model) =>
      this.sdk.embeddings.embed(
        {
          ...input,
          model,
        },
        options,
      ),
    );
  }

  async embedBatch(
    input: Omit<EmbedBatchInput, "model"> & { model?: ModelAlias },
    options?: RequestOptions,
  ): Promise<EmbedBatchResult> {
    if (input.model) {
      return this.sdk.embeddings.embedBatch(
        {
          ...input,
          model: input.model,
        },
        options,
      );
    }

    const models = this.selectModels("embedding");
    return this.withFallback(models, async (model) =>
      this.sdk.embeddings.embedBatch(
        {
          ...input,
          model,
        },
        options,
      ),
    );
  }

  async rerank(
    input: Omit<RerankInput, "model"> & { model?: ModelAlias },
    options?: RequestOptions,
  ): Promise<RerankResult> {
    if (input.model) {
      return this.sdk.rerank.rank(
        {
          ...input,
          model: input.model,
        },
        options,
      );
    }

    const models = this.selectModels("rerank");
    return this.withFallback(models, async (model) =>
      this.sdk.rerank.rank(
        {
          ...input,
          model,
        },
        options,
      ),
    );
  }
}
