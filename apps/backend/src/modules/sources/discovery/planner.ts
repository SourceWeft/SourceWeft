import { z } from "zod";
import { completeStructuredWithDefaultChat } from "../../../shared/model-gateway/index";
import type { ContentBillingPort } from "../../content/billing-port";
import { DISCOVERY_MAX_QUERIES } from "./candidates";

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["queries"],
  properties: {
    queries: {
      type: "array",
      description:
        "3 to 5 distinct web search queries that together cover the topic from different angles.",
      items: { type: "string" },
    },
  },
} as const;

const planSchema = z.object({ queries: z.array(z.string()) });

export function buildPlanPrompt(topic: string) {
  return {
    system:
      "You plan web searches for a research task. Write short, distinct queries " +
      "that would find authoritative, readable pages (articles, documentation, reports) " +
      "about the topic from different angles. Use the language of the topic, and add an " +
      "English query when the topic is not in English and English sources are likely to help.",
    user: `Topic: ${topic}`,
  };
}

/** The usable queries from the model's answer: trimmed, distinct, capped. Empty when unusable. */
export function parsePlannedQueries(
  value: unknown,
  max = DISCOVERY_MAX_QUERIES,
) {
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) return [];
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const raw of parsed.data.queries) {
    const query = raw.replace(/\s+/g, " ").trim().slice(0, 240);
    const key = query.toLowerCase();
    if (!query || seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= max) break;
  }
  return queries;
}

/**
 * Plans the searches for a topic with one structured model call on the
 * default chat model, charged to the requester. Billing admission runs first,
 * so a requester without credits never reaches the search provider.
 */
export async function planSearchQueries(input: {
  billing: ContentBillingPort;
  teamId: string;
  workspaceId: string;
  userId: string;
  topic: string;
  requestId: string;
}) {
  const prompt = buildPlanPrompt(input.topic);
  const output = await completeStructuredWithDefaultChat({
    billing: input.billing,
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    actorUserId: input.userId,
    scopeId: input.requestId,
    scopeKind: "api-request",
    operation: "source.discovery",
    referenceId: `workspace:${input.workspaceId}:discovery`,
    system: prompt.system,
    user: prompt.user,
    schema: {
      name: "source_discovery_plan",
      description: "Web search queries for a research topic.",
      schema: PLAN_SCHEMA as unknown as Record<string, unknown>,
    },
    maxTokens: 300,
  });
  const queries = parsePlannedQueries(output);
  if (queries.length === 0) {
    throw new Error("The model returned no usable search queries");
  }
  return queries;
}
