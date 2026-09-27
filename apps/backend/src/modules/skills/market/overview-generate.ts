import { createHash } from "node:crypto";
import type { SkillOverviewJson, SkillOverviewLocale } from "@sourceweft/db";
import { logger } from "../../../shared/logger";
import {
  getSystemModelReadiness,
  withSystemModel,
  type SystemModelPurpose,
} from "../../../shared/model-gateway/system-client";
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
import { findSkillOverviewSubject } from "./overview-repository";
import { skillCategoryDefinitions } from "./taxonomy";

/**
 * Writing one version's AI overview (skill-marketplace-plan §17.4): read
 * SKILL.md and the file list, ask the system model for three independently
 * written locale overviews plus one evidence-backed classification, and
 * publish atomically. Platform work: billed to no team (see
 * shared/model-gateway/system-client.ts).
 */

// The answer is two short overviews; nothing hidden is spent first, since
// thinking is off.
export const SKILL_OVERVIEW_MAX_OUTPUT_TOKENS = 4_500;

export type SkillOverviewModelCall = (input: {
  prompt: SkillOverviewPrompt;
  skillVersionId: string;
  // The unit of work the call belongs to: one per job try.
  scopeId: string;
}) => Promise<{ output: unknown; model: string }>;

/**
 * The model call through the system model: no tools, a JSON schema to answer
 * in, thinking pinned off (DeepSeek thinks by default, and a forced
 * structured-output tool choice is refused while it does), output capped.
 * The evaluation asks the same question under its own purpose.
 */
export function createSkillOverviewModelCall(
  purpose: Extract<
    SystemModelPurpose,
    "skill_market.overview" | "skill_market.evaluation"
  > = "skill_market.overview",
): SkillOverviewModelCall {
  return async ({ prompt, skillVersionId, scopeId }) => {
    const result = await withSystemModel(
      { purpose, subjectRef: `skill-version:${skillVersionId}`, scopeId },
      (chat) =>
        chat.complete({
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
        }),
    );
    const output = result.structuredOutput ?? textOf(result.raw?.content);
    return {
      output,
      model: result.providerModel ?? result.model,
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
        | "system-model-not-ready";
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
  // Whether the system model can take the call; its readiness unless given.
  modelReady?: () => Promise<boolean>;
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
  const modelReady = input.modelReady
    ? await input.modelReady()
    : (await getSystemModelReadiness()).ready;
  if (!modelReady)
    return { status: "skipped", reason: "system-model-not-ready" };

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
