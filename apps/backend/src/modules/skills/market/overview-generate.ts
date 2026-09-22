import { createHash } from "node:crypto";
import type { SkillOverviewJson, SkillOverviewLocale } from "@sourceweft/db";
import { logger } from "../../../shared/logger";
import {
  resolveModelGatewayProfile,
  withBilledModelGateway,
} from "../../../shared/model-gateway/index";
import type { ContentBillingPort } from "../../content/billing-port";
import { marketSkillName } from "./read-repository";
import {
  claimSkillAnalysis,
  findCachedSkillAnalysis,
  publishSkillAnalysis,
  requestSkillAnalysis,
} from "./analysis-repository";
import {
  SKILL_OVERVIEW_OUTPUT_JSON_SCHEMA,
  SKILL_OVERVIEW_OUTPUT_NAME,
  buildSkillOverviewPrompt,
  parseSkillOverviewOutput,
  type SkillOverviewPrompt,
} from "./overview-prompt";
import {
  findSkillOverviewSubject,
  readSkillOverviewBilling,
  type SkillOverviewBillingTarget,
} from "./overview-repository";
import { skillCategoryDefinitions } from "./taxonomy";

/**
 * Writing one version's AI overview (skill-marketplace-plan §17.4): read
 * SKILL.md and the file list, ask the default chat model for three independently written locale
 * overviews plus one evidence-backed classification, and publish atomically. Billed to the market's configured team, workspace and member.
 */

// The answer is two short overviews; nothing hidden is spent first, since
// thinking is off.
export const SKILL_OVERVIEW_MAX_OUTPUT_TOKENS = 4_500;
const SKILL_OVERVIEW_TIMEOUT_MS = 120_000;

export type SkillOverviewModelCall = (input: {
  prompt: SkillOverviewPrompt;
  billing: SkillOverviewBillingTarget;
  skillVersionId: string;
  // Idempotency root for the billing scope: one per job try.
  scopeId: string;
}) => Promise<{ output: unknown; model: string }>;

/**
 * The model call through the billed gateway: no tools, a JSON schema to answer
 * in, thinking pinned off (DeepSeek thinks by default, and a forced
 * structured-output tool choice is refused while it does), output capped.
 */
export function createSkillOverviewModelCall(
  billingPort: ContentBillingPort,
  resolvedProfile?: Awaited<ReturnType<typeof resolveModelGatewayProfile>>,
): SkillOverviewModelCall {
  return async ({ prompt, billing, skillVersionId, scopeId }) => {
    const profile =
      resolvedProfile ??
      (await resolveModelGatewayProfile({
        kind: "chat",
        defaultRequired: true,
      }));
    if (!profile) {
      throw new Error("Default chat model gateway profile is not configured");
    }
    const result = await withBilledModelGateway(
      {
        billing: billingPort,
        gatewayConfigId: profile.gatewayConfigId,
        context: {
          teamId: billing.teamId,
          workspaceId: billing.workspaceId,
          actorUserId: billing.userId,
          feature: "skill_market",
          intent: { mode: "billed" },
          scopeKind: "worker-job",
          scopeId,
        },
      },
      (gateway) =>
        gateway.chat.complete(
          {
            model: profile.modelAlias,
            profileAlias: profile.profileAlias,
            executionMode: "GLOBAL",
            messages: [
              { role: "system", content: prompt.system },
              { role: "user", content: prompt.user },
            ],
            structuredOutput: {
              name: SKILL_OVERVIEW_OUTPUT_NAME,
              description:
                "A catalog overview of the skill in English, Simplified Chinese and Taiwan Traditional Chinese, plus one classification.",
              schema: SKILL_OVERVIEW_OUTPUT_JSON_SCHEMA,
            },
            thinking: { mode: "off", enabled: false, includeReasoning: false },
            maxTokens: SKILL_OVERVIEW_MAX_OUTPUT_TOKENS,
            temperature: 0.2,
          },
          {
            traceId: scopeId,
            timeoutMs: SKILL_OVERVIEW_TIMEOUT_MS,
            operation: "skill_market.overview",
            modelKind: "chat",
            gatewayConfigId: profile.gatewayConfigId,
            profileAlias: profile.profileAlias,
            modelAlias: profile.modelAlias,
            referenceId: `skill-version:${skillVersionId}:overview`,
            billingMetadata: { skillVersionId },
          },
        ),
    );
    const output = result.structuredOutput ?? textOf(result.raw?.content);
    return {
      output,
      model: result.providerModel ?? result.model ?? profile.modelAlias,
    };
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : part && typeof part === "object" && typeof part.text === "string"
            ? part.text
            : "",
      )
      .join("");
  }
  return "";
}

export type GenerateSkillOverviewResult =
  | { status: "generated"; model: string }
  | { status: "copied"; rows: number }
  | {
      status: "skipped";
      reason:
        | "missing-version"
        | "not-eligible"
        | "already-generated"
        | "no-skill-md"
        | "billing-unset";
    };

/**
 * Writes one version's overviews unless there is nothing to do: the version
 * is gone or no longer the public one, it already has them, or the same
 * content elsewhere does (copied instead). Throws on a model or output
 * failure, for the job to retry.
 */
export async function generateSkillOverview(input: {
  skillVersionId: string;
  scopeId: string;
  callModel: SkillOverviewModelCall;
  // Who pays; the market setting unless given.
  readBilling?: () => Promise<SkillOverviewBillingTarget | null>;
  requestId?: string;
  force?: boolean;
  modelConfigurationKey?: string;
}): Promise<GenerateSkillOverviewResult> {
  const subject = await findSkillOverviewSubject(input.skillVersionId);
  if (!subject) return { status: "skipped", reason: "missing-version" };
  if (!subject.eligible) return { status: "skipped", reason: "not-eligible" };
  const state = input.requestId
    ? await claimSkillAnalysis(subject.skillVersionId, input.requestId)
    : await requestSkillAnalysis(
        subject.skillVersionId,
        Boolean(input.force),
      ).then((row) =>
        row ? claimSkillAnalysis(subject.skillVersionId, row.requestId) : null,
      );
  if (!state) return { status: "skipped", reason: "already-generated" };
  if (!subject.skillMd?.trim()) {
    return { status: "skipped", reason: "no-skill-md" };
  }
  const billing = input.readBilling
    ? await input.readBilling()
    : (await readSkillOverviewBilling()).billing;
  if (!billing) return { status: "skipped", reason: "billing-unset" };

  const registry = subject.manifest.registry;
  const prompt = buildSkillOverviewPrompt({
    name: marketSkillName({ slug: subject.slug, manifest: subject.manifest }),
    capability: registry?.capability ?? null,
    skillMd: subject.skillMd,
    files: (registry?.fileManifest ?? [])
      .filter((file) => file.path !== "SKILL.md")
      .map((file) => ({ path: file.path, role: file.role })),
    categories: skillCategoryDefinitions,
  });
  // Test-injected callers without a model identity cannot reuse production cache.
  const resultKey = createHash("sha256")
    .update(
      JSON.stringify({
        bundle: subject.bundleSha256,
        prompt,
        model: input.modelConfigurationKey ?? input.scopeId,
      }),
    )
    .digest("hex");
  if (!state.force && !input.force && input.modelConfigurationKey) {
    const cached = await findCachedSkillAnalysis(
      resultKey,
      subject.skillVersionId,
    );
    if (cached) {
      const published = await publishSkillAnalysis({
        ...cached,
        skillId: subject.skillId,
        skillVersionId: subject.skillVersionId,
        requestId: state.requestId,
        resultKey,
        modelConfigurationKey: input.modelConfigurationKey,
        bundleSha256: subject.bundleSha256,
      });
      return published
        ? { status: "copied", rows: 3 }
        : { status: "skipped", reason: "not-eligible" };
    }
  }
  const { output, model } = await input.callModel({
    prompt,
    billing,
    skillVersionId: subject.skillVersionId,
    scopeId: input.scopeId,
  });
  const parsed = parseSkillOverviewOutput(
    output,
    skillCategoryDefinitions.map((category) => category.slug),
    subject.skillMd,
    prompt.sourceText,
  );
  const overviews: Record<SkillOverviewLocale, SkillOverviewJson> = {
    en: parsed.en,
    "zh-CN": parsed["zh-CN"],
    "zh-TW": parsed["zh-TW"],
  };
  const published = await publishSkillAnalysis({
    skillId: subject.skillId,
    requestId: state.requestId,
    resultKey,
    modelConfigurationKey: input.modelConfigurationKey,
    classification: parsed.classification,
    skillVersionId: subject.skillVersionId,
    bundleSha256: subject.bundleSha256,
    model,
    overviews,
  });
  if (!published) return { status: "skipped", reason: "not-eligible" };
  logger.info("Skill overview generated", {
    skillId: subject.skillId,
    skillVersionId: subject.skillVersionId,
    model,
    truncated: prompt.truncated,
  });
  return { status: "generated", model };
}
