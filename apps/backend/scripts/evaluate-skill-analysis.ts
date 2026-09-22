import { resolveSkillAnalysisModelKey } from "../src/modules/skills/market/analysis-model";
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, open } from "node:fs/promises";
import { parseArgs } from "node:util";
import { and, eq, asc } from "drizzle-orm";
import {
  db,
  skillDefinitions,
  skillVersions,
  skillMarketSettings,
} from "@sourceweft/db";
import {
  parseEvaluationDataset,
  stratifyEvaluationCases,
  summarizeEvaluation,
  skillAnalysisModelIdentity,
  type EvaluationCase,
  type EvaluationResult,
} from "../src/modules/skills/market/analysis-evaluation";
import {
  buildSkillOverviewPrompt,
  parseSkillOverviewOutput,
  SKILL_ANALYSIS_PROMPT_VERSION,
  SKILL_ANALYSIS_TAXONOMY_VERSION,
} from "../src/modules/skills/market/overview-prompt";
import { skillCategoryDefinitions } from "../src/modules/skills/market/taxonomy";
import {
  findSkillOverviewSubject,
  readSkillOverviewBilling,
} from "../src/modules/skills/market/overview-repository";
import { marketSkillName } from "../src/modules/skills/market/read-repository";

async function main() {
  const { values } = parseArgs({
    options: {
      export: { type: "string" },
      run: { type: "string" },
      output: { type: "string" },
      count: { type: "string", default: "100" },
      "record-quality": { type: "boolean", default: false },
    },
  });
  if (Boolean(values.export) === Boolean(values.run))
    throw new Error("Choose --export FILE or --run FILE --output FILE");
  if (values.export) {
    if (values["record-quality"] || values.output)
      throw new Error("Export does not accept --record-quality or --output");
    const count = Number(values.count);
    if (!Number.isInteger(count) || count < 100 || count > 1000)
      throw new Error("Count must be an integer between 100 and 1000");
    const rows = await db
      .select({
        versionId: skillVersions.id,
        description: skillDefinitions.description,
      })
      .from(skillVersions)
      .innerJoin(
        skillDefinitions,
        eq(skillDefinitions.id, skillVersions.skillId),
      )
      .where(
        and(
          eq(skillVersions.isCurrent, true),
          eq(skillVersions.status, "published"),
          eq(skillDefinitions.visibility, "public"),
          eq(skillDefinitions.status, "active"),
          eq(skillDefinitions.sourceType, "registry_github"),
        ),
      )
      .orderBy(asc(skillVersions.id));
    const candidates: EvaluationCase[] = [];
    for (const row of rows) {
      const subject = await findSkillOverviewSubject(row.versionId);
      if (!subject?.eligible || !subject.skillMd?.trim()) continue;
      candidates.push({
        skillId: subject.skillId,
        skillVersionId: subject.skillVersionId,
        name: marketSkillName(subject),
        description: row.description,
        skillMd: subject.skillMd,
        capability: subject.manifest.registry?.capability ?? null,
        files: (subject.manifest.registry?.fileManifest ?? [])
          .filter((file) => file.path !== "SKILL.md")
          .map((file) => ({ path: file.path, role: file.role })),
        expectedPrimary: null,
        reviewedBy: null,
      });
    }
    const dataset = parseEvaluationDataset({
      promptVersion: SKILL_ANALYSIS_PROMPT_VERSION,
      taxonomyVersion: SKILL_ANALYSIS_TAXONOMY_VERSION,
      exportedAt: new Date().toISOString(),
      cases: stratifyEvaluationCases(candidates, count),
    });
    await writeFile(values.export, JSON.stringify(dataset, null, 2) + "\n", {
      flag: "wx",
    });
    console.log(
      `Exported ${dataset.cases.length} unlabeled cases for human review.`,
    );
    return;
  }
  if (!values.output) throw new Error("--run requires --output FILE");
  const data = parseEvaluationDataset(
    JSON.parse(await readFile(values.run!, "utf8")),
  );
  const { billing } = await readSkillOverviewBilling();
  if (!billing) throw new Error("Configure overview billing before evaluation");
  const { resolveModelGatewayProfile } =
    await import("../src/shared/model-gateway/index");
  const profile = await resolveModelGatewayProfile({
    kind: "chat",
    defaultRequired: true,
  });
  if (!profile)
    throw new Error("Default chat model gateway profile is not configured");
  // Explicit allowlist: never serialize profile configJson, credentials, or provider errors.
  const modelIdentity = skillAnalysisModelIdentity(profile);
  const modelConfigurationKey = await resolveSkillAnalysisModelKey(profile);
  // Reserve the report path before any billed call; never lose a run to an existing output.
  const reportFile = await open(values.output, "wx");
  await reportFile.close();
  const { billingRuntime } = await import("../src/billing-host/bindings");
  const { createSkillOverviewModelCall } =
    await import("../src/modules/skills/market/overview-generate");
  const callModel = createSkillOverviewModelCall(billingRuntime, profile);
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const results: EvaluationResult[] = [];
  for (const row of data.cases) {
    const start = performance.now();
    const prompt = buildSkillOverviewPrompt({
      ...row,
      categories: skillCategoryDefinitions,
    });
    let model: string | null = null;
    let prediction: string | null = null;
    let error: EvaluationResult["error"] = null;
    try {
      const result = await callModel({
        prompt,
        billing,
        skillVersionId: row.skillVersionId,
        scopeId: `skill-analysis-eval:${runId}:${row.skillVersionId}`,
      });
      model = result.model;
      try {
        prediction = parseSkillOverviewOutput(
          result.output,
          skillCategoryDefinitions.map((category) => category.slug),
          row.skillMd,
          prompt.sourceText,
        ).classification.primary;
      } catch {
        error = "invalid-model-output";
      }
    } catch {
      error = "model-call-failed";
    }
    results.push({
      skillId: row.skillId,
      prediction,
      model,
      error,
      durationMs: Math.round(performance.now() - start),
    });
    console.log(
      `Evaluated ${results.length}/${data.cases.length}${error ? ` (${error})` : ""}`,
    );
  }
  const report = {
    ...summarizeEvaluation(data, results),
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    modelIdentity,
    modelConfigurationKey,
    billing,
  };
  await writeFile(values.output, JSON.stringify(report, null, 2) + "\n");
  if (values["record-quality"]) {
    if (!report.passed)
      throw new Error(
        "Report saved; quality gate failed, quality setting was not changed",
      );
    const value = {
      promptVersion: report.promptVersion,
      taxonomyVersion: report.taxonomyVersion,
      total: report.total,
      accuracy: report.accuracy,
      baselineAccuracy: report.baselineAccuracy,
      reviewed: true,
      datasetHash: report.datasetHash,
      runId,
      modelIdentity,
      modelConfigurationKey,
      completedAt: report.completedAt,
    };
    await db
      .insert(skillMarketSettings)
      .values({ key: "analysis.quality", value, updatedBy: billing.userId })
      .onConflictDoUpdate({
        target: skillMarketSettings.key,
        set: { value, updatedBy: billing.userId, updatedAt: new Date() },
      });
  }
  console.log(
    `Report saved. Quality gate: ${report.passed ? "passed" : "failed"}.`,
  );
}
// Safe top-level diagnostics: database/provider failures can include credentials.
main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    const safe =
      /^(Choose --|Export does not|Count must|Need [0-9]+ unique|Invalid evaluation dataset:|Dataset versions are stale;|Duplicate evaluation (skillId|skillVersionId|source content)|--run requires|Configure overview billing|Default chat model gateway profile is not configured|Report saved; quality gate failed)/.test(
        message,
      );
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    console.error(
      safe
        ? message
        : `Evaluation failed (${["EEXIST", "ENOENT", "EACCES", "ECONNREFUSED", "ENOTFOUND"].includes(code) ? code : "configuration/database/runtime error"}); no fallback was used. Provider error details are withheld to protect credentials.`,
    );
    process.exit(1);
  });
