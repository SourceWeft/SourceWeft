import { assertModelAliasAllowed } from "../config";
import { buildTracingMetadata } from "../middleware/tracing";
import { normalizeUsage } from "../normalize/usage";
import { requestJson } from "../transport/http";
import type {
  RerankInput,
  RerankItem,
  RerankResult,
  RequestOptions,
  ResolvedLiteLLMClientConfig,
} from "../types";
import { compactObject, deepCompact, isRecord } from "../utils/object";

function toRerankItems(raw: Record<string, unknown>): RerankItem[] {
  if (!Array.isArray(raw.results)) {
    return [];
  }

  const output: RerankItem[] = [];
  for (const item of raw.results) {
    if (!isRecord(item)) {
      continue;
    }

    const index =
      typeof item.index === "number" && Number.isInteger(item.index)
        ? item.index
        : undefined;

    const relevanceScore =
      typeof item.relevance_score === "number"
        ? item.relevance_score
        : typeof item.score === "number"
          ? item.score
          : undefined;

    if (index === undefined || relevanceScore === undefined) {
      continue;
    }

    output.push({
      index,
      relevanceScore,
      document: isRecord(item.document) ? item.document : undefined,
    });
  }

  return output;
}

function normalizeRerankDocument(
  value: string | Record<string, unknown>,
): string | Record<string, unknown> {
  if (typeof value === "string") {
    return value;
  }

  if (isRecord(value)) {
    return value;
  }

  return String(value);
}

export class LiteLLMRerankEndpoint {
  constructor(private readonly config: ResolvedLiteLLMClientConfig) {}

  async rank(
    input: RerankInput,
    options?: RequestOptions,
  ): Promise<RerankResult> {
    assertModelAliasAllowed(input.model, this.config);

    const body = deepCompact(
      compactObject({
        model: input.model,
        query: input.query,
        documents: input.documents.map((item) => normalizeRerankDocument(item)),
        top_n: input.topN,
        return_documents: input.returnDocuments,
        metadata: buildTracingMetadata(
          input.metadata,
          options,
          this.config.requestMetadata,
        ),
        ...input.extraBody,
      }),
    ) as Record<string, unknown>;

    const raw = await requestJson<Record<string, unknown>>(this.config, {
      path: "/rerank",
      method: "POST",
      body,
      options,
    });

    return {
      model: typeof raw.model === "string" ? raw.model : input.model,
      results: toRerankItems(raw),
      usage: normalizeUsage(raw.usage),
      raw,
    };
  }
}
