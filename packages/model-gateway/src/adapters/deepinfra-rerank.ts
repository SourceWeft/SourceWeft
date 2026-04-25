import { createHttpGatewayError } from "../errors";
import { normalizeUsage } from "../normalize/usage";
import { resolveDeepInfraBaseUrls } from "./deepinfra-url";
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
  const candidates = [raw.scores, raw.results, raw.data];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }

    const rows = Array.isArray(candidate[0]) ? candidate[0] : candidate;
    const scores = rows
      .map((item) => {
        if (typeof item === "number") {
          return item;
        }
        const record = toRecord(item);
        if (!record) {
          return null;
        }
        if (typeof record.score === "number") {
          return record.score;
        }
        if (typeof record.relevance_score === "number") {
          return record.relevance_score;
        }
        return null;
      })
      .filter((score): score is number => typeof score === "number");

    if (scores.length > 0) {
      return scores;
    }
  }

  return [];
}

export class DeepInfraRerankTransport implements RerankTransport {
  readonly kind = "deepinfra" as const;

  async execute(input: Parameters<RerankTransport["execute"]>[0]) {
    const { inferenceBaseUrl } = resolveDeepInfraBaseUrls(input.target.baseUrl);
    const encodedModel = input.target.providerModel
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    const response = await input.fetch(
      `${inferenceBaseUrl}/${encodedModel}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...input.target.defaultHeaders,
          ...(input.target.apiKey ? { Authorization: `Bearer ${input.target.apiKey}` } : {}),
        },
        body: JSON.stringify({
          queries: [input.payload.query],
          documents: input.payload.documents.map(normalizeDocument),
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
    const scores = resolveScores(raw);
    const results = scores
      .map((score, index) => ({
        index,
        relevanceScore: score,
        document: input.payload.returnDocuments
          ? toRecord(input.payload.documents[index]) ?? undefined
          : undefined,
      }))
      .sort((left, right) => right.relevanceScore - left.relevanceScore)
      .slice(0, input.payload.topN ?? scores.length);

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
