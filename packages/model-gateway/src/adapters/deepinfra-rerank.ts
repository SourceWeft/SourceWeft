import { buildProviderAuthHeaders } from "../auth-headers";
import { createHttpGatewayError } from "../errors";
import { normalizeModelCallObservation } from "../observation/normalize";
import type { RerankTransport } from "./types";

function normalizeDocument(document: string | Record<string, unknown>) {
  return typeof document === "string" ? document : JSON.stringify(document);
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function resolveScores(raw: Record<string, unknown>): number[] {
  if (!Array.isArray(raw.scores)) {
    return [];
  }

  const rows = Array.isArray(raw.scores[0]) ? raw.scores[0] : raw.scores;
  return rows.filter((score): score is number => typeof score === "number");
}

function resolveInferenceBaseUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/+$/, "")}/inference`;
}

export class DeepInfraRerankTransport implements RerankTransport {
  readonly kind = "deepinfra" as const;

  async execute(input: Parameters<RerankTransport["execute"]>[0]) {
    const inferenceBaseUrl = resolveInferenceBaseUrl(input.target.baseUrl);
    const encodedModel = input.target.providerModel
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    const response = await input.fetch(`${inferenceBaseUrl}/${encodedModel}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...input.target.defaultHeaders,
        ...buildProviderAuthHeaders(input.target),
      },
      body: JSON.stringify({
        queries: [input.payload.query],
        documents: input.payload.documents.map(normalizeDocument),
        ...(input.payload.extraBody ?? {}),
      }),
    });

    if (!response.ok) {
      const body = (await response.json()) as Record<string, unknown>;
      throw createHttpGatewayError({
        statusCode: response.status,
        body,
        requestId: response.headers.get("x-request-id") ?? undefined,
      });
    }

    const raw = (await response.json()) as Record<string, unknown>;
    const observation = normalizeModelCallObservation({
      modelAlias: input.target.routeDecision.alias,
      context: {
        target: input.target,
        modality: "rerank",
        rawResponse: raw,
        responseHeaders: response.headers,
      },
    });
    const scores = resolveScores(raw);
    const results = scores
      .map((score, index) => ({
        index,
        relevanceScore: score,
        document: input.payload.returnDocuments
          ? (toRecord(input.payload.documents[index]) ?? undefined)
          : undefined,
      }))
      .sort((left, right) => right.relevanceScore - left.relevanceScore)
      .slice(0, input.payload.topN ?? scores.length);

    return {
      model:
        typeof raw.model === "string" ? raw.model : input.target.providerModel,
      results,
      usage: observation.usage,
      observation,
      provider: input.target.provider,
      providerModel: input.target.providerModel,
      routeDecision: input.target.routeDecision,
      traceId: input.options?.traceId,
      raw,
    };
  }
}
