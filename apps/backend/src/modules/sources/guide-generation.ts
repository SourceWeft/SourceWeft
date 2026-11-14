import {
  sourceGuideContentSchema,
  type SourceGuideContent,
} from "@sourceweft/contracts/sources";
import {
  requireDefaultModelGatewayProfile,
  withBilledModelGateway,
} from "../../shared/model-gateway/index";
import type { ContentBillingPort } from "../content/billing-port";

/**
 * Only the start of a source is sent: a guide is an overview, and the cap keeps
 * what one generation can cost bounded. A code constant, not a setting.
 */
export const GUIDE_MAX_INPUT_CHARS = 12_000;
const GUIDE_MAX_OUTPUT_TOKENS = 900;

const GUIDE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "topics", "suggestedQuestions"],
  properties: {
    summary: {
      type: "string",
      description: "A summary of the source in 3 to 5 sentences.",
    },
    topics: {
      type: "array",
      description: "The 3 to 8 main topics the source covers, as short phrases.",
      items: { type: "string" },
    },
    suggestedQuestions: {
      type: "array",
      description:
        "3 to 5 questions a reader could ask about this source, each answerable from it.",
      items: { type: "string" },
    },
  },
} as const;

export function buildGuidePrompt(input: { title: string; content: string }) {
  const excerpt = input.content.slice(0, GUIDE_MAX_INPUT_CHARS);
  return {
    system:
      "You write a short guide to a document so a reader knows what it contains " +
      "before opening it. Use only what the text says; do not add facts. " +
      "Write in the same language as the document.",
    user:
      `Title: ${input.title}\n\n` +
      (excerpt.length < input.content.length
        ? "The document is long; only its beginning is shown.\n\n"
        : "") +
      `Document:\n${excerpt}`,
  };
}

/** Parses the model's structured answer; null when it is unusable. */
export function parseGuideContent(value: unknown): SourceGuideContent | null {
  const parsed = sourceGuideContentSchema.safeParse(value);
  if (!parsed.success) return null;
  const summary = parsed.data.summary.trim();
  const topics = parsed.data.topics.map((item) => item.trim()).filter(Boolean);
  const suggestedQuestions = parsed.data.suggestedQuestions
    .map((item) => item.trim())
    .filter(Boolean);
  if (!summary || suggestedQuestions.length === 0) return null;
  return {
    summary,
    topics: topics.slice(0, 8),
    suggestedQuestions: suggestedQuestions.slice(0, 5),
  };
}

/**
 * Generates a guide with the deployment's default chat model, charged to
 * `payer`. It never substitutes another model: if the default profile is not
 * usable the call fails and the caller records it.
 */
export async function generateGuideContent(input: {
  billing: ContentBillingPort;
  teamId: string;
  workspaceId: string;
  sourceId: string;
  actorUserId: string;
  title: string;
  content: string;
  scopeId: string;
}): Promise<SourceGuideContent> {
  const profile = await requireDefaultModelGatewayProfile("chat");
  const prompt = buildGuidePrompt({
    title: input.title,
    content: input.content,
  });

  const completion = await withBilledModelGateway(
    {
      billing: input.billing,
      gatewayConfigId: profile.gatewayConfigId,
      context: {
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        feature: "chat",
        intent: { mode: "billed" },
        scopeKind: "worker-job",
        scopeId: input.scopeId,
      },
    },
    (gateway) =>
      gateway.chat.complete(
        {
          model: profile.modelAlias,
          profileAlias: profile.profileAlias,
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
          structuredOutput: {
            name: "source_guide",
            description: "A summary, main topics and suggested questions.",
            schema: GUIDE_SCHEMA as unknown as Record<string, unknown>,
          },
          thinking: { mode: "off", enabled: false, includeReasoning: false },
          maxTokens: GUIDE_MAX_OUTPUT_TOKENS,
          temperature: 0.2,
        },
        {
          traceId: input.scopeId,
          operation: "source.guide",
          modelKind: "chat",
          gatewayConfigId: profile.gatewayConfigId,
          profileAlias: profile.profileAlias,
          modelAlias: profile.modelAlias,
          referenceId: `source:${input.sourceId}:guide`,
          idempotencyKey: `source-guide:${input.scopeId}`,
        },
      ),
  );

  const content = parseGuideContent(completion.structuredOutput);
  if (!content) {
    throw new Error("The model returned no usable source guide");
  }
  return content;
}
