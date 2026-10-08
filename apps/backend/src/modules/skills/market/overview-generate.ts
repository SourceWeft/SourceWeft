import type { SkillAnalysisClassification } from "@sourceweft/db";
import { generateOverview } from "../../catalog-overview/generate";
import { createOverviewModelCall } from "../../catalog-overview/model";
import type {
  OverviewGenerateResult,
  OverviewSubject,
  OverviewSubjectAdapter,
} from "../../catalog-overview/types";
import type { SystemModelPurpose } from "../../../shared/model-gateway/system-client";
import { marketSkillName } from "./read-repository";
import {
  SKILL_OVERVIEW_OUTPUT_JSON_SCHEMA,
  SKILL_OVERVIEW_OUTPUT_NAME,
  buildSkillOverviewPrompt,
  parseSkillOverviewOutput,
  type SkillOverviewPrompt,
} from "./overview-prompt";
import {
  findSkillOverviewSubject,
  type SkillOverviewSubject,
} from "./overview-repository";
import { skillOverviewStore } from "./overview-store";
import { skillCategoryDefinitions } from "./taxonomy";

/**
 * Writing one version's AI overview (skill-marketplace-plan §17.4): read
 * SKILL.md and the file list, ask the system model for three independently
 * written locale overviews plus one evidence-backed classification, and
 * publish atomically. Platform work: billed to no team (see
 * shared/model-gateway/system-client.ts).
 *
 * The pipeline is the catalog overview engine's (modules/catalog-overview);
 * this is the skill kind's adapter to it.
 */

// The answer is two short overviews; nothing hidden is spent first, since
// thinking is off.
export const SKILL_OVERVIEW_MAX_OUTPUT_TOKENS = 4_500;

const SKILL_OVERVIEW_OUTPUT_DESCRIPTION =
  "A catalog overview of the skill in English, Simplified Chinese and Taiwan Traditional Chinese, plus one classification.";

export type SkillOverviewModelCall = (input: {
  prompt: SkillOverviewPrompt;
  skillVersionId: string;
  // The unit of work the call belongs to: one per job try.
  scopeId: string;
}) => Promise<{ output: unknown; model: string }>;

type SkillSubject = SkillOverviewSubject & OverviewSubject;

/** The skill kind: SKILL.md and its file list in, the skill tables out. */
export const skillOverviewAdapter: OverviewSubjectAdapter<
  SkillSubject,
  SkillOverviewPrompt,
  SkillAnalysisClassification,
  "no-skill-md"
> = {
  kind: "skill",
  label: "Skill",
  purpose: "skill_market.overview",
  subjectRef: (skillVersionId) => `skill-version:${skillVersionId}`,
  output: {
    name: SKILL_OVERVIEW_OUTPUT_NAME,
    description: SKILL_OVERVIEW_OUTPUT_DESCRIPTION,
    schema: SKILL_OVERVIEW_OUTPUT_JSON_SCHEMA,
    maxTokens: SKILL_OVERVIEW_MAX_OUTPUT_TOKENS,
  },
  async loadSubject(skillVersionId) {
    const subject = await findSkillOverviewSubject(skillVersionId);
    return subject
      ? {
          ...subject,
          versionId: subject.skillVersionId,
          fingerprint: subject.bundleSha256,
        }
      : null;
  },
  skipReason: (subject) => (subject.skillMd?.trim() ? null : "no-skill-md"),
  buildPrompt(subject) {
    const registry = subject.manifest.registry;
    return buildSkillOverviewPrompt({
      name: marketSkillName({
        slug: subject.slug,
        manifest: subject.manifest,
        skillMd: subject.skillMd,
      }),
      capability: registry?.capability ?? null,
      skillMd: subject.skillMd ?? "",
      files: (registry?.fileManifest ?? [])
        .filter((file) => file.path !== "SKILL.md")
        .map((file) => ({ path: file.path, role: file.role })),
      categories: skillCategoryDefinitions,
    });
  },
  parseOutput(raw, subject, prompt) {
    const parsed = parseSkillOverviewOutput(
      raw,
      skillCategoryDefinitions.map((category) => category.slug),
      subject.skillMd ?? "",
      prompt.sourceText,
    );
    return {
      overviews: {
        en: parsed.en,
        "zh-CN": parsed["zh-CN"],
        "zh-TW": parsed["zh-TW"],
      },
      classification: parsed.classification,
    };
  },
  logFields: (subject, prompt) => ({
    skillId: subject.skillId,
    skillVersionId: subject.skillVersionId,
    truncated: prompt.truncated,
  }),
  store: skillOverviewStore,
};

/**
 * The model call through the system model (the engine's
 * `createOverviewModelCall` with the skill adapter's output spec). The
 * evaluation asks the same question under its own purpose.
 */
export function createSkillOverviewModelCall(
  purpose: Extract<
    SystemModelPurpose,
    "skill_market.overview" | "skill_market.evaluation"
  > = "skill_market.overview",
): SkillOverviewModelCall {
  const call = createOverviewModelCall<SkillOverviewPrompt>({
    purpose,
    subjectRef: skillOverviewAdapter.subjectRef,
    output: skillOverviewAdapter.output,
  });
  return ({ prompt, skillVersionId, scopeId }) =>
    call({ prompt, versionId: skillVersionId, scopeId });
}

export type GenerateSkillOverviewResult = OverviewGenerateResult<"no-skill-md">;

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
  const { skillVersionId, callModel, ...rest } = input;
  return generateOverview(skillOverviewAdapter, {
    ...rest,
    versionId: skillVersionId,
    callModel: ({ prompt, versionId, scopeId }) =>
      callModel({ prompt, skillVersionId: versionId, scopeId }),
  });
}
