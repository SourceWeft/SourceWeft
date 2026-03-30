import type {
  EmbedBatchInput,
  EmbedInput,
  ModelAlias,
  RequestOptions,
} from "../types";
import { LiteLLMRouter } from "../router/litellm-router";
import {
  LiteLLMEmbeddings,
  type LiteLLMEmbeddingsParams,
} from "./litellm-embeddings";

export interface LiteLLMEmbeddingsRouterParams
  extends Omit<LiteLLMEmbeddingsParams, "client" | "model"> {
  router: LiteLLMRouter;
  model?: ModelAlias;
}

export class LiteLLMEmbeddingsRouter extends LiteLLMEmbeddings {
  private readonly router: LiteLLMRouter;

  constructor(fields: LiteLLMEmbeddingsRouterParams) {
    super({
      ...fields,
      model: fields.model ?? "embed-default",
      client: undefined,
    });

    this.router = fields.router;
  }

  protected override embedWithClient(
    input: EmbedInput,
    options?: RequestOptions,
  ) {
    const { model: _ignoredModel, ...rest } = input;
    return this.router.embed(rest, options);
  }

  protected override embedBatchWithClient(
    input: EmbedBatchInput,
    options?: RequestOptions,
  ) {
    const { model: _ignoredModel, ...rest } = input;
    return this.router.embedBatch(rest, options);
  }
}
