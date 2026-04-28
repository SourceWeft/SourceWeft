import { createHttpGatewayError } from "../errors";
import { normalizeUsage } from "../normalize/usage";
import type { RerankTransport } from "./types";

function resolveRelevanceScore(
  row: Record<string, unknown>,
  providerKind: string,
) {
  const value =
    providerKind === "openrouter" ? row.relevance_score : row.score;
  return typeof value === "number" ? value : 0;
}

export class OpenAICompatibleRerankTransport implements RerankTransport {
  readonly kind = "openai-compatible" as const;

  async execute(input: Parameters<RerankTransport["execute"]>[0]) {
    const response = await input.fetch(
      `${input.target.baseUrl.replace(/\/+$/, "")}/rerank`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...input.target.defaultHeaders,
          ...(input.target.apiKey ? { Authorization: `Bearer ${input.target.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: input.target.providerModel,
          query: input.payload.query,
          documents: input.payload.documents.map((document) =>
            typeof document === "string" ? document : JSON.stringify(document),
          ),
          top_n: input.payload.topN,
          return_documents: input.payload.returnDocuments,
          metadata: input.payload.metadata ?? {},
          ...(input.payload.extraBody ?? {}),
        }),
      },
    );

    if (!response.ok) {
      const body = (await response.json()) as Record<string, unknown>;
      throw createHttpGatewayError({
        statusCode: response.status,
        body,
        requestId: response.headers.get("x-request-id") ?? undefined,
      });
    }

    const raw = (await response.json()) as Record<string, unknown>;
    const rows = Array.isArray(raw.results) ? raw.results : [];
    const results = rows
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .map((row) => ({
        index: typeof row.index === "number" ? row.index : -1,
        relevanceScore: resolveRelevanceScore(row, input.target.providerKind),
        document:
          typeof row.index === "number" && input.payload.returnDocuments
            ? (typeof input.payload.documents[row.index] === "string"
                ? (row.document && typeof row.document === "object"
                    ? (row.document as Record<string, unknown>)
                    : undefined)
                : (input.payload.documents[row.index] as Record<string, unknown>))
            : undefined,
      }))
      .filter((item) => item.index >= 0);

    return {
      model: typeof raw.model === "string" ? raw.model : input.target.providerModel,
      results,
      usage: normalizeUsage(raw.usage),
      provider: input.target.provider,
      providerModel: input.target.providerModel,
      routeDecision: input.target.routeDecision,
      traceId: input.options?.traceId,
      raw,
    };
  }
}
