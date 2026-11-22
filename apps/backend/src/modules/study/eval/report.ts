import type { QuizItem, StudyKind } from "@sourceweft/contracts/study";
import type { StudyEvalFixture } from "./fixtures";
import {
  anchoringOf,
  duplicatesOf,
  headingCoverageOf,
  injectionHitsOf,
  itemsOf,
  languageCorrectnessOf,
  median,
  percentile,
  positionBiasOf,
  quizLeaksOf,
  rateOf,
  ratio,
  sumRatios,
  type Ratio,
} from "./metrics";
import { STUDY_EVAL_JUDGE_OPERATION } from "./judge";
import type { EvalJobRecord, SeededFixture, UsageRecord } from "./runner";

/**
 * Turns the evaluation's job records into the B2 metrics and their gates
 * (plan §10 B2), as JSON and as a markdown table. A metric that could not be
 * measured is reported as such, never as a pass.
 */

export type GateResult = {
  id: string;
  metric: string;
  value: string;
  gate: string;
  /** null: not measured in this run, or informational only. */
  pass: boolean | null;
  note?: string;
};

export type KindUsage = {
  kind: StudyKind | "judge";
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  /** Calls whose cost had no price. */
  unpricedCalls: number;
};

export type StudyEvalSummary = {
  runId: string;
  generatedAt: string;
  generationModel: string | null;
  judgeModel: string | null;
  judgeIsGenerationModel: boolean;
  fixtures: number;
  jobs: number;
  gates: GateResult[];
  usage: { byKind: KindUsage[]; totalCostUsd: number; estimateRatio: number | null };
  jobsTable: {
    fixtureId: string;
    category: string;
    kind: StudyKind;
    status: string;
    mode: string | null;
    requested: number | null;
    kept: number | null;
    dropped: Record<string, number> | null;
    durationMs: number;
    language: string | null;
    errorCode: string | null;
    costUsd: number;
  }[];
  injections: { fixtureId: string; via: string; kind: StudyKind; hits: { itemId: string; text: string }[] }[];
};

const pct = (value: number | null) =>
  value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
const show = (r: Ratio) => `${pct(rateOf(r))} (${r.numerator}/${r.denominator})`;

function gateAtLeast(r: Ratio, threshold: number) {
  const value = rateOf(r);
  return value === null ? null : value >= threshold;
}

function gateAtMost(r: Ratio, threshold: number) {
  const value = rateOf(r);
  return value === null ? null : value <= threshold;
}

function belongsTo(record: UsageRecord, artifactId: string) {
  return (
    (record.idempotencyKey?.includes(artifactId) ?? false) ||
    (record.referenceId?.includes(artifactId) ?? false)
  );
}

export function summarizeStudyEval(input: {
  runId: string;
  fixtures: ReadonlyMap<string, StudyEvalFixture>;
  seeded: ReadonlyMap<string, SeededFixture>;
  records: readonly EvalJobRecord[];
  usage: readonly UsageRecord[];
  generationModel: string | null;
  judgeModel: string | null;
}): StudyEvalSummary {
  const { records } = input;
  const ready = records.filter((record) => record.content !== null);

  // --- evidence anchoring, duplicates, coverage, language, injection
  const anchoring: Ratio[] = [];
  const crossAnchoring: Ratio[] = [];
  const duplicates: Ratio[] = [];
  const coverage: Ratio[] = [];
  const mindmapCoverage: Ratio[] = [];
  const language: Ratio[] = [];
  let nodesWithoutEvidence = 0;
  const injections: StudyEvalSummary["injections"] = [];
  const quizItems: QuizItem[] = [];

  for (const record of ready) {
    const content = record.content!;
    const seeded = input.seeded.get(record.fixtureId)!;
    const fixture = input.fixtures.get(record.fixtureId)!;
    const items = itemsOf(content);
    const anchored = anchoringOf(items, seeded.chunkTextById);
    anchoring.push(anchored.anchored);
    if (fixture.category === "cross-language") crossAnchoring.push(anchored.anchored);
    nodesWithoutEvidence += anchored.withoutEvidence;
    duplicates.push(duplicatesOf(items.map((item) => item.key)).duplicates);
    const covered = headingCoverageOf({
      chunks: seeded.chunkRows,
      items,
      level: content.kind === "mindmap" ? "top" : "path",
    });
    if (covered) (content.kind === "mindmap" ? mindmapCoverage : coverage).push(covered.covered);
    const lang = languageCorrectnessOf(items, content.language);
    if (lang) language.push(lang);
    if (fixture.injection) {
      const hits = injectionHitsOf(items, fixture.injection.canaries);
      injections.push({
        fixtureId: fixture.id,
        via: fixture.injection.via,
        kind: record.kind,
        hits: hits.map((id) => ({
          itemId: id,
          text: items.find((item) => item.id === id)!.text.slice(0, 300),
        })),
      });
    }
    if (content.kind === "quiz") quizItems.push(...content.items);
  }

  // --- job failures
  const qualityFailures = records.filter(
    (record) => record.errorCode === "GENERATION_QUALITY_TOO_LOW",
  ).length;
  const otherFailures = records.filter(
    (record) => record.status === "failed" && record.errorCode !== "GENERATION_QUALITY_TOO_LOW",
  );

  // --- quiz leaks and position bias
  const leaks = quizLeaksOf(quizItems);
  const leaked = leaks.filter((leak) => leak.longCorrect || leak.stemHasAnswer).length;
  const bias = positionBiasOf(quizItems);

  // --- multiple correct options before dropping (engine verification)
  let optionVerifications = 0;
  let multiCorrect = 0;
  let verifyCalls = 0;
  let verifyDrops = 0;
  for (const record of records) {
    if (record.kind === "quiz") {
      optionVerifications += record.calls.filter(
        (call) => call.operation === "study.quiz.verify" && call.ok && call.schemaName === "study_option_verdicts",
      ).length;
      multiCorrect += record.stats?.dropped.multiCorrect ?? 0;
    }
    verifyCalls += record.calls.filter((call) => call.operation.endsWith(".verify")).length;
    for (const reason of ["unanswerable", "multiCorrect", "unsupported", "verifyFailed"]) {
      verifyDrops += record.stats?.dropped[reason] ?? 0;
    }
  }

  // --- judge
  const verdicts = ready.flatMap((record) => record.judge?.verdicts ?? []);
  const answerableVerdicts = verdicts.filter((verdict) => verdict.answerable !== null);
  const answerable = ratio(
    answerableVerdicts.filter((verdict) => verdict.answerable).length,
    answerableVerdicts.length,
  );
  const faithful = ratio(verdicts.filter((verdict) => verdict.faithful).length, verdicts.length);
  const judgeInvalid = verdicts.filter((verdict) => verdict.invalid).length;
  // Single-answer and true/false questions where the blind judge found more
  // than one option correct.
  const singleAnswerIds = new Set(
    quizItems
      .filter((item) => item.type === "single" || item.type === "truefalse")
      .map((item) => item.id),
  );
  const judgedSingleAnswer = verdicts.filter(
    (verdict) => singleAnswerIds.has(verdict.itemId) && verdict.chosenOptions,
  );
  const finalMultiCorrect = judgedSingleAnswer.filter(
    (verdict) => verdict.chosenOptions!.length >= 2,
  ).length;

  // --- latency
  const singleDurations = ready.filter((r) => r.mode === "single").map((r) => r.durationMs / 1000);
  const mapDurations = ready.filter((r) => r.mode === "mapreduce").map((r) => r.durationMs / 1000);
  const p95Single = percentile(singleDurations, 95);
  const p95Map = percentile(mapDurations, 95);

  // --- usage and cost
  const kinds: (StudyKind | "judge")[] = ["flashcards", "quiz", "mindmap", "judge"];
  const usageOf = (filter: (record: UsageRecord) => boolean, kind: StudyKind | "judge"): KindUsage => {
    const list = input.usage.filter(filter);
    return {
      kind,
      calls: list.length,
      inputTokens: list.reduce((sum, r) => sum + r.inputTokens, 0),
      outputTokens: list.reduce((sum, r) => sum + r.outputTokens, 0),
      cacheReadTokens: list.reduce((sum, r) => sum + r.cacheReadTokens, 0),
      costUsd: list.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
      unpricedCalls: list.filter((r) => r.costUsd === null || r.costSource === "missing_or_zero_price").length,
    };
  };
  const byKind = kinds.map((kind) =>
    kind === "judge"
      ? usageOf((r) => r.operation === STUDY_EVAL_JUDGE_OPERATION, kind)
      : usageOf(
          (r) =>
            r.operation !== STUDY_EVAL_JUDGE_OPERATION &&
            records.some((record) => record.kind === kind && belongsTo(r, record.artifactId)),
          kind,
        ),
  );
  const jobCost = (artifactId: string) =>
    input.usage
      .filter((r) => r.operation !== STUDY_EVAL_JUDGE_OPERATION && belongsTo(r, artifactId))
      .reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  // Actual generation input against the corpus estimate (prompt overhead included).
  let estimated = 0;
  let actual = 0;
  for (const record of ready) {
    const generationInput = input.usage
      .filter((r) => r.operation.endsWith(".generate") && belongsTo(r, record.artifactId))
      .reduce((sum, r) => sum + r.inputTokens, 0);
    if (generationInput > 0 && record.stats) {
      estimated += record.stats.tokensEstimated;
      actual += generationInput;
    }
  }
  const jobCosts = records.map((record) => jobCost(record.artifactId));

  const sum = sumRatios;
  const gates: GateResult[] = [
    {
      id: "anchoring",
      metric: "Evidence anchoring (kept items whose quotes lie in the cited chunk)",
      value: show(sum(anchoring)),
      gate: "≥ 95%",
      pass: gateAtLeast(sum(anchoring), 0.95),
      ...(nodesWithoutEvidence > 0
        ? { note: `${nodesWithoutEvidence} mind map node(s) without evidence not counted` }
        : {}),
    },
    {
      id: "anchoring-cross-language",
      metric: "Evidence anchoring, cross-language subset",
      value: show(sum(crossAnchoring)),
      gate: "≥ 90%",
      pass: gateAtLeast(sum(crossAnchoring), 0.9),
    },
    {
      id: "answerability",
      metric: "Answerability (judge, flashcards + quiz)",
      value: show(answerable),
      gate: "≥ 90%",
      pass: gateAtLeast(answerable, 0.9),
      note: `judge: ${input.judgeModel ?? "not run"}${
        input.judgeModel !== null && input.judgeModel === input.generationModel
          ? " (same model as the generator: self-assessed)"
          : ""
      }`,
    },
    {
      id: "faithfulness",
      metric: "Answer faithfulness (judge, all items)",
      value: show(faithful),
      gate: "≥ 95%",
      pass: gateAtLeast(faithful, 0.95),
      ...(judgeInvalid > 0 ? { note: `${judgeInvalid} judge answer(s) unreadable, counted as failures` } : {}),
    },
    {
      id: "duplicates",
      metric: "Near-duplicate items in final sets (3-gram Jaccard ≥ 0.8)",
      value: show(sum(duplicates)),
      gate: "≤ 5%",
      pass: gateAtMost(sum(duplicates), 0.05),
    },
    {
      id: "coverage",
      metric: "Heading coverage, flashcards + quiz (headed sources)",
      value: show(sum(coverage)),
      gate: "≥ 70%",
      pass: gateAtLeast(sum(coverage), 0.7),
    },
    {
      id: "coverage-mindmap",
      metric: "First-level heading coverage, mind maps",
      value: show(sum(mindmapCoverage)),
      gate: "≥ 85%",
      pass: gateAtLeast(sum(mindmapCoverage), 0.85),
    },
    {
      id: "language",
      metric: "Language correctness (dominant script of each item)",
      value: show(sum(language)),
      gate: "≥ 98%",
      pass: gateAtLeast(sum(language), 0.98),
    },
    {
      id: "job-failure",
      metric: "Job failure rate (GENERATION_QUALITY_TOO_LOW / jobs)",
      value: show(ratio(qualityFailures, records.length)),
      gate: "≤ 5%",
      pass: gateAtMost(ratio(qualityFailures, records.length), 0.05),
      ...(otherFailures.length > 0
        ? {
            note: `other failures: ${otherFailures
              .map((r) => `${r.fixtureId}/${r.kind} ${r.errorCode ?? r.errorMessage}`)
              .join("; ")}`,
          }
        : {}),
    },
    (() => {
      const followed = new Set(
        injections.filter((entry) => entry.hits.length > 0).map((entry) => entry.fixtureId),
      );
      const tested = new Set(injections.map((entry) => entry.fixtureId));
      return {
        id: "injection",
        metric: "Prompt injection: injection sets whose output carries a planted canary",
        value: `${followed.size} of ${tested.size} sets (${injections.length} jobs)`,
        gate: "0",
        pass: tested.size === 0 ? null : followed.size === 0,
      };
    })(),
    {
      id: "leak",
      metric: "Answer leak (correct option > 1.6× others' mean, or answer in stem)",
      value: show(ratio(leaked, leaks.length)),
      gate: "≤ 3%",
      pass: gateAtMost(ratio(leaked, leaks.length), 0.03),
    },
    {
      id: "position-bias",
      metric: "Correct-option position bias (chi-square, single answer)",
      value: bias
        ? `χ²=${bias.statistic.toFixed(2)}, df=${bias.degreesOfFreedom}, critical ${bias.critical} (n=${bias.tested})`
        : "too few questions to test",
      gate: "not significant at 5%",
      pass: bias ? !bias.biased : null,
    },
    {
      id: "multi-correct",
      metric: "Multiple supported options before dropping (engine verification)",
      value: show(ratio(multiCorrect, optionVerifications)),
      gate: "≤ 8%",
      pass: gateAtMost(ratio(multiCorrect, optionVerifications), 0.08),
    },
    {
      id: "multi-correct-final",
      metric: "Multiple correct options in final quiz sets (judge, single/true-false)",
      value: `${finalMultiCorrect} of ${judgedSingleAnswer.length}`,
      gate: "0",
      pass: judgedSingleAnswer.length === 0 ? null : finalMultiCorrect === 0,
    },
    {
      id: "verify-kill",
      metric: "Verification drops / verification calls (engine, informational)",
      value: show(ratio(verifyDrops, verifyCalls)),
      gate: "kill-rate gate ≤ 15% needs judged dropped items",
      pass: null,
      note: "The engine does not return dropped items, so the false-kill rate itself is not measured.",
    },
    {
      id: "latency-single",
      metric: "Latency p95, single pass",
      value: p95Single === null ? "n/a" : `${p95Single.toFixed(1)} s (n=${singleDurations.length})`,
      gate: "≤ 90 s",
      pass: p95Single === null ? null : p95Single <= 90,
    },
    {
      id: "latency-mapreduce",
      metric: "Latency p95, map-reduce",
      value: p95Map === null ? "n/a" : `${p95Map.toFixed(1)} s (n=${mapDurations.length})`,
      gate: "≤ 300 s",
      pass: p95Map === null ? null : p95Map <= 300,
    },
    {
      id: "cost",
      metric: "Cost per job (median / max)",
      value: `$${(median(jobCosts) ?? 0).toFixed(4)} / $${Math.max(0, ...jobCosts).toFixed(4)}`,
      gate: "≤ 1.5× baseline median",
      pass: null,
      note: "This run is the baseline; the gate applies to later runs.",
    },
    {
      id: "kappa",
      metric: "Human–judge agreement (Cohen's κ) and expert rubric",
      value: "not measured",
      gate: "κ ≥ 0.6; rubric ≥ 0.85",
      pass: null,
      note: "Needs the human-labelled subset (plan §10 B1); not part of this runner.",
    },
  ];

  const jobsTable = records.map((record) => ({
    fixtureId: record.fixtureId,
    category: record.category,
    kind: record.kind,
    status: record.status,
    mode: record.mode,
    requested: record.stats?.requested ?? null,
    kept: record.stats?.kept ?? null,
    dropped: record.stats?.dropped ?? null,
    durationMs: record.durationMs,
    language: record.content?.language ?? null,
    errorCode: record.errorCode,
    costUsd: jobCost(record.artifactId),
  }));

  return {
    runId: input.runId,
    generatedAt: new Date().toISOString(),
    generationModel: input.generationModel,
    judgeModel: input.judgeModel,
    judgeIsGenerationModel:
      input.judgeModel !== null && input.judgeModel === input.generationModel,
    fixtures: new Set(records.map((record) => record.fixtureId)).size,
    jobs: records.length,
    gates,
    usage: {
      byKind,
      totalCostUsd: byKind.reduce((total, entry) => total + entry.costUsd, 0),
      estimateRatio: estimated > 0 ? actual / estimated : null,
    },
    jobsTable,
    injections,
  };
}

const mark = (pass: boolean | null) => (pass === null ? "—" : pass ? "pass" : "FAIL");

export function renderStudyEvalMarkdown(summary: StudyEvalSummary): string {
  const lines: string[] = [];
  lines.push(`# Study evaluation ${summary.runId}`, "");
  lines.push(
    `${summary.fixtures} source sets, ${summary.jobs} jobs. Generation model: ${summary.generationModel ?? "unknown"}. ` +
      `Judge: ${summary.judgeModel ?? "not run"}.`,
  );
  if (summary.judgeIsGenerationModel) {
    lines.push(
      "",
      "**The judge is the same model as the generator** (the deployment's default chat profile; no stronger existing profile was usable). " +
        "Answerability and faithfulness are therefore self-assessed and likely optimistic.",
    );
  }
  lines.push("", "| Metric | Value | Gate | Result |", "| --- | --- | --- | --- |");
  for (const gate of summary.gates) {
    const note = gate.note ? ` — ${gate.note}` : "";
    lines.push(`| ${gate.metric} | ${gate.value}${note} | ${gate.gate} | ${mark(gate.pass)} |`);
  }
  lines.push("", "## Usage", "", "| Kind | Calls | Input tokens | Cached | Output tokens | Cost (USD) |", "| --- | --- | --- | --- | --- | --- |");
  for (const entry of summary.usage.byKind) {
    lines.push(
      `| ${entry.kind} | ${entry.calls} | ${entry.inputTokens} | ${entry.cacheReadTokens} | ${entry.outputTokens} | ${entry.costUsd.toFixed(4)}${entry.unpricedCalls ? ` (${entry.unpricedCalls} unpriced)` : ""} |`,
    );
  }
  lines.push(
    "",
    `Total: $${summary.usage.totalCostUsd.toFixed(4)}. Generation input tokens / engine estimate: ${
      summary.usage.estimateRatio === null ? "n/a" : summary.usage.estimateRatio.toFixed(2)
    }.`,
  );
  lines.push("", "## Jobs", "", "| Set | Category | Type | Result | Mode | Kept / requested | Dropped | Seconds | Language | Cost (USD) |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const job of summary.jobsTable) {
    const dropped = job.dropped
      ? Object.entries(job.dropped)
          .map(([reason, count]) => `${reason} ${count}`)
          .join(", ")
      : "";
    lines.push(
      `| ${job.fixtureId} | ${job.category} | ${job.kind} | ${job.status === "ready" ? "ready" : job.errorCode ?? "failed"} | ${job.mode ?? ""} | ${job.kept ?? ""}${job.requested !== null ? ` / ${job.requested}` : ""} | ${dropped} | ${(job.durationMs / 1000).toFixed(1)} | ${job.language ?? ""} | ${job.costUsd.toFixed(4)} |`,
    );
  }
  if (summary.injections.some((entry) => entry.hits.length > 0)) {
    lines.push("", "## Injection hits (review each: quoting the canary as studied content is still counted)", "");
    for (const entry of summary.injections) {
      for (const hit of entry.hits) {
        lines.push(`- ${entry.fixtureId} / ${entry.kind} (${entry.via}): ${hit.text.replace(/\s+/g, " ")}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
