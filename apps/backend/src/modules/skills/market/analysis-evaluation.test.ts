import { describe, it, expect } from "vitest";
import {
  parseEvaluationDataset,
  summarizeEvaluation,
  stratifyEvaluationCases,
  skillAnalysisModelConfigurationKey,
  type EvaluationCase,
  type EvaluationResult,
} from "./analysis-evaluation";
import {
  SKILL_ANALYSIS_PROMPT_VERSION,
  SKILL_ANALYSIS_TAXONOMY_VERSION,
} from "./overview-prompt";
const row = (i: number): EvaluationCase => ({
  skillId: `skill-${i}`,
  skillVersionId: `version-${i}`,
  name: "zzz",
  description: "qqq",
  skillMd: `Create software ${i}`,
  capability: null,
  files: [],
  expectedPrimary: "development",
  reviewedBy: "human@example.test",
});
const dataset = (count = 100) => ({
  promptVersion: SKILL_ANALYSIS_PROMPT_VERSION,
  taxonomyVersion: SKILL_ANALYSIS_TAXONOMY_VERSION,
  exportedAt: "2026-09-22",
  cases: Array.from({ length: count }, (_, i) => row(i)),
});
const results = (count = 100, correct = count): EvaluationResult[] =>
  Array.from({ length: count }, (_, i) => ({
    skillId: `skill-${i}`,
    prediction: i < correct ? "development" : null,
    model: "test",
    error: null,
    durationMs: 1,
  }));
describe("analysis evaluation quality gate", () => {
  it("uses a stable non-secret model configuration identity", () => {
    const profile = {
      id: "p",
      gatewayConfigId: "g",
      profileAlias: "chat",
      modelAlias: "model",
      updatedAt: "v1",
      configJson: { apiKey: "secret-one" },
    };
    const key = skillAnalysisModelConfigurationKey(profile);
    expect(
      skillAnalysisModelConfigurationKey({
        ...profile,
        configJson: { apiKey: "secret-two" },
      } as typeof profile),
    ).toBe(key);
    expect(
      skillAnalysisModelConfigurationKey({ ...profile, modelAlias: "other" }),
    ).not.toBe(key);
    expect(
      skillAnalysisModelConfigurationKey({ ...profile, updatedAt: "v2" }),
    ).toBe(key);
  });
  it("requires 100 human-reviewed cases and 90% accuracy", () => {
    expect(summarizeEvaluation(dataset(), results(100, 90)).passed).toBe(true);
    expect(summarizeEvaluation(dataset(), results(100, 89)).passed).toBe(false);
    expect(summarizeEvaluation(dataset(99), results(99)).passed).toBe(false);
  });
  it("requires ten percentage points improvement over baseline", () => {
    const data = dataset();
    data.cases.forEach((r, i) => {
      if (i < 81) r.name = "software development";
    });
    expect(summarizeEvaluation(data, results(100, 90)).passed).toBe(false);
    data.cases[80]!.name = "zzz";
    expect(summarizeEvaluation(data, results(100, 90)).passed).toBe(true);
  });
  it("unreviewed or unlabeled cases cannot pass", () => {
    const data = dataset();
    data.cases[0]!.reviewedBy = null;
    expect(summarizeEvaluation(data, results()).passed).toBe(false);
    data.cases[0]!.expectedPrimary = null;
    expect(summarizeEvaluation(data, results()).labeled).toBe(99);
  });
  it("counts errors as incorrect even with matching predictions", () => {
    const rows = results();
    rows[0]!.error = "invalid-model-output";
    const report = summarizeEvaluation(dataset(), rows);
    expect(report.accuracy).toBe(0.99);
    expect(report.coverage).toBe(0.99);
    expect(report.perCategory.development?.correct).toBe(99);
  });
  it("rejects invalid labels, stale versions, duplicate IDs and duplicate content", () => {
    const data = dataset();
    expect(() =>
      parseEvaluationDataset({ ...data, promptVersion: "old" }),
    ).toThrow(/stale/);
    expect(() =>
      parseEvaluationDataset({
        ...data,
        cases: [{ ...row(0), expectedPrimary: "fake" }],
      }),
    ).toThrow(/Invalid/);
    expect(() =>
      parseEvaluationDataset({ ...data, cases: [row(0), row(0)] }),
    ).toThrow(/Duplicate/);
    expect(() =>
      parseEvaluationDataset({
        ...data,
        cases: [row(0), { ...row(1), skillMd: row(0).skillMd }],
      }),
    ).toThrow(/Duplicate/);
    expect(() => summarizeEvaluation(data, results(99))).toThrow(/Incomplete/);
    expect(() =>
      parseEvaluationDataset({
        ...data,
        cases: [{ ...row(0), reviewedBy: " " }],
      }),
    ).toThrow(/Invalid/);
  });
  it("stratifies deterministically and fails when sources are insufficient", () => {
    expect(stratifyEvaluationCases(dataset().cases, 100)).toHaveLength(100);
    expect(() => stratifyEvaluationCases([row(0), row(0)], 2)).toThrow(
      /found 1/,
    );
  });
});
