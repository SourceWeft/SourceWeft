import { createHash } from "node:crypto";
import { z } from "zod";
import { SKILL_ANALYSIS_CATEGORY_SLUGS } from "./overview-taxonomy";
import {
  SKILL_ANALYSIS_PROMPT_VERSION,
  SKILL_ANALYSIS_TAXONOMY_VERSION,
} from "./overview-prompt";
import { classifySkillCategories } from "./taxonomy";

const caseSchema = z.object({
  skillId: z.string().trim().min(1),
  skillVersionId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  description: z.string(),
  skillMd: z.string().refine((value) => value.trim().length > 0),
  capability: z.enum(["prompt-only", "executable"]).nullable(),
  files: z.array(
    z.object({
      path: z.string().min(1),
      role: z.string().nullable().optional(),
    }),
  ),
  expectedPrimary: z.enum(SKILL_ANALYSIS_CATEGORY_SLUGS).nullable(),
  reviewedBy: z.string().trim().min(1).nullable(),
});
const datasetSchema = z.object({
  promptVersion: z.string(),
  taxonomyVersion: z.string(),
  exportedAt: z.string(),
  cases: z.array(caseSchema).min(1).max(1000),
});
export type EvaluationCase = z.infer<typeof caseSchema>;
export type EvaluationDataset = z.infer<typeof datasetSchema>;
export function parseEvaluationDataset(raw: unknown): EvaluationDataset {
  const parsed = datasetSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      "Invalid evaluation dataset: check required source, labels, and reviewer fields",
    );
  const data = parsed.data;
  if (
    data.promptVersion !== SKILL_ANALYSIS_PROMPT_VERSION ||
    data.taxonomyVersion !== SKILL_ANALYSIS_TAXONOMY_VERSION
  )
    throw new Error(
      "Dataset versions are stale; export and review current versions",
    );
  for (const key of ["skillId", "skillVersionId"] as const) {
    if (new Set(data.cases.map((row) => row[key])).size !== data.cases.length)
      throw new Error(`Duplicate evaluation ${key}`);
  }
  if (
    new Set(data.cases.map((row) => hash(row.skillMd))).size !==
    data.cases.length
  )
    throw new Error("Duplicate evaluation source content");
  return data;
}
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function evaluationDatasetHash(data: EvaluationDataset) {
  return hash(JSON.stringify(data));
}
export type EvaluationResult = {
  skillId: string;
  prediction: string | null;
  model: string | null;
  error: "model-call-failed" | "invalid-model-output" | null;
  durationMs: number;
};
export function summarizeEvaluation(
  data: EvaluationDataset,
  results: EvaluationResult[],
) {
  // Always validate here as well: recording cannot bypass uniqueness/version checks.
  data = parseEvaluationDataset(data);
  if (
    results.length !== data.cases.length ||
    new Set(results.map((r) => r.skillId)).size !== results.length
  )
    throw new Error("Incomplete or duplicate evaluation results");
  const byId = new Map(results.map((r) => [r.skillId, r]));
  const cases = data.cases.map((row) => {
    const result = byId.get(row.skillId);
    if (!result) throw new Error("Missing evaluation result");
    const baseline = classifySkillCategories(row)[0] ?? null;
    const labeled = row.expectedPrimary !== null;
    return {
      ...result,
      skillVersionId: row.skillVersionId,
      expectedPrimary: row.expectedPrimary,
      reviewedBy: row.reviewedBy,
      baseline,
      correct:
        labeled && !result.error && result.prediction === row.expectedPrimary,
      baselineCorrect: labeled && baseline === row.expectedPrimary,
    };
  });
  const labeled = cases.filter((row) => row.expectedPrimary !== null);
  const reviewed = labeled.filter((row) => row.reviewedBy !== null).length;
  const accuracy = labeled.length
    ? labeled.filter((row) => row.correct).length / labeled.length
    : 0;
  const baselineAccuracy = labeled.length
    ? labeled.filter((row) => row.baselineCorrect).length / labeled.length
    : 0;
  const delta = accuracy - baselineAccuracy;
  const coverage =
    cases.filter((row) => !row.error && row.prediction !== null).length /
    cases.length;
  const perCategory = Object.fromEntries(
    SKILL_ANALYSIS_CATEGORY_SLUGS.map((slug) => {
      const rows = labeled.filter((row) => row.expectedPrimary === slug);
      return [
        slug,
        {
          total: rows.length,
          correct: rows.filter((row) => row.correct).length,
          accuracy: rows.length
            ? rows.filter((row) => row.correct).length / rows.length
            : null,
        },
      ];
    }),
  );
  return {
    datasetHash: evaluationDatasetHash(data),
    promptVersion: SKILL_ANALYSIS_PROMPT_VERSION,
    taxonomyVersion: SKILL_ANALYSIS_TAXONOMY_VERSION,
    total: cases.length,
    labeled: labeled.length,
    reviewedCount: reviewed,
    reviewed: reviewed === cases.length,
    accuracy,
    baselineAccuracy,
    delta,
    coverage,
    passed:
      reviewed === cases.length &&
      reviewed >= 100 &&
      accuracy >= 0.9 &&
      delta >= 0.1 - 1e-9,
    durationMs: cases.reduce((sum, row) => sum + row.durationMs, 0),
    cost: null,
    costNote:
      "The overview model-call interface does not expose settled cost; billing still applies.",
    perCategory,
    cases,
  };
}

/** Deterministic round-robin across keyword baseline classes, no model labels. */
export function stratifyEvaluationCases(
  cases: EvaluationCase[],
  count: number,
): EvaluationCase[] {
  const groups = new Map<string, EvaluationCase[]>();
  const seenSources = new Set<string>();
  for (const row of [...cases].sort((a, b) =>
    a.skillId.localeCompare(b.skillId),
  )) {
    const sourceHash = hash(row.skillMd.trim());
    if (seenSources.has(sourceHash)) continue;
    seenSources.add(sourceHash);
    const slug = classifySkillCategories(row)[0] ?? "other";
    groups.set(slug, [...(groups.get(slug) ?? []), row]);
  }
  const selected: EvaluationCase[] = [];
  const buckets = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, rows]) => rows);
  for (let index = 0; selected.length < count; index++) {
    const batch = buckets.flatMap((rows) =>
      rows[index] ? [rows[index]!] : [],
    );
    if (!batch.length) break;
    selected.push(...batch.slice(0, count - selected.length));
  }
  if (selected.length < count)
    throw new Error(
      `Need ${count} unique eligible source cases; found ${selected.length}`,
    );
  return selected;
}

/** Non-secret identity; pricing timestamps and credential rotations are excluded. */
export function skillAnalysisModelIdentity(profile: {
  id: string;
  gatewayConfigId: string;
  profileAlias: string;
  modelAlias: string;
  updatedAt?: string;
}) {
  return {
    profileId: profile.id,
    gatewayConfigId: profile.gatewayConfigId,
    profileAlias: profile.profileAlias,
    modelAlias: profile.modelAlias,
  };
}
export function skillAnalysisModelConfigurationKey(
  profile: Parameters<typeof skillAnalysisModelIdentity>[0],
  routes: unknown = null,
) {
  return hash(
    JSON.stringify({ profile: skillAnalysisModelIdentity(profile), routes }),
  );
}
