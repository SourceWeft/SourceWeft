import { assertModelAliasAllowed } from "../config";
import { buildTracingMetadata } from "../middleware/tracing";
import { normalizeUsage } from "../normalize/usage";
import { requestJson } from "../transport/http";
import type {
  EmbedBatchInput,
  EmbedBatchResult,
  EmbedInput,
  EmbedResult,
  RequestOptions,
  ResolvedLiteLLMClientConfig,
} from "../types";
import { compactObject, deepCompact, isRecord } from "../utils/object";

function asEmbeddingArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const numbers: number[] = [];
  for (const item of value) {
    if (typeof item === "number" && Number.isFinite(item)) {
      numbers.push(item);
    }
  }

  return numbers.length > 0 ? numbers : undefined;
}

function normalizeEmbeddings(raw: Record<string, unknown>): number[][] {
  if (!Array.isArray(raw.data)) {
    return [];
  }

  const output: number[][] = [];
  for (const item of raw.data) {
    if (!isRecord(item)) {
      continue;
    }

    const embedding = asEmbeddingArray(item.embedding);
    if (!embedding) {
      continue;
    }

    output.push(embedding);
  }

  return output;
}

function buildEmbeddingsBody(
  config: ResolvedLiteLLMClientConfig,
  input: EmbedInput | EmbedBatchInput,
  options: RequestOptions | undefined,
): Record<string, unknown> {
  assertModelAliasAllowed(input.model, config);

  return deepCompact(
    compactObject({
      model: input.model,
      input:
        "text" in input
          ? input.text
          : Array.isArray(input.texts)
            ? input.texts
            : [],
      dimensions: input.dimensions,
      encoding_format: input.encodingFormat,
      input_type: input.inputType,
      metadata: buildTracingMetadata(
        input.metadata,
        options,
        config.requestMetadata,
      ),
      ...input.extraBody,
    }),
  ) as Record<string, unknown>;
}

export class LiteLLMEmbeddingsEndpoint {
  constructor(private readonly config: ResolvedLiteLLMClientConfig) {}

  async embed(
    input: EmbedInput,
    options?: RequestOptions,
  ): Promise<EmbedResult> {
    const body = buildEmbeddingsBody(this.config, input, options);
    const raw = await requestJson<Record<string, unknown>>(this.config, {
      path: "/embeddings",
      method: "POST",
      body,
      options,
    });

    const vectors = normalizeEmbeddings(raw);

    return {
      model: typeof raw.model === "string" ? raw.model : input.model,
      embedding: vectors[0] ?? [],
      usage: normalizeUsage(raw.usage),
      raw,
    };
  }

  async embedBatch(
    input: EmbedBatchInput,
    options?: RequestOptions,
  ): Promise<EmbedBatchResult> {
    const body = buildEmbeddingsBody(this.config, input, options);
    const raw = await requestJson<Record<string, unknown>>(this.config, {
      path: "/embeddings",
      method: "POST",
      body,
      options,
    });

    return {
      model: typeof raw.model === "string" ? raw.model : input.model,
      embeddings: normalizeEmbeddings(raw),
      usage: normalizeUsage(raw.usage),
      raw,
    };
  }
}
