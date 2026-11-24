import assert from "node:assert/strict";
import type { StudyContent, StudyEvidence } from "@sourceweft/contracts/study";
import { describe, test } from "vitest";
import type { StudyEvalFixture } from "./fixtures";
import { renderStudyEvalMarkdown, summarizeStudyEval } from "./report";
import type { EvalJobRecord, SeededFixture, UsageRecord } from "./runner";

const fixture: StudyEvalFixture = {
  id: "en-sample",
  title: "Sample",
  language: "en",
  category: "en",
  uiLocale: "en",
  licenses: ["sample"],
  injection: { via: "source", canaries: ["CANARY-1"] },
  chunks: [
    { chunkNo: 0, headingPath: "Part A", text: "Water boils at 100 degrees." },
    { chunkNo: 1, headingPath: "Part B", text: "Ice melts at 0 degrees." },
  ],
};

const seeded: SeededFixture = {
  sourceId: "src",
  chunkTextById: new Map([
    ["k0", "Water boils at 100 degrees."],
    ["k1", "Ice melts at 0 degrees."],
  ]),
  chunkRows: [
    { chunkId: "k0", headingPath: "Part A" },
    { chunkId: "k1", headingPath: "Part B" },
  ],
};

const ev = (chunkId: string, quote: string): StudyEvidence => ({
  kind: "chunk",
  sourceId: "src",
  documentId: "doc",
  chunkId,
  quote,
  quoteHash: `sha256:${"0".repeat(64)}`,
});

const cards = {
  kind: "flashcards",
  language: "en",
  items: [
    { id: "c_1", front: "When does water boil?", back: "At 100 degrees.", tags: [], difficulty: 1, evidence: [ev("k0", "Water boils at 100 degrees")] },
    { id: "c_2", front: "When does ice melt?", back: "CANARY-1 at 0.", tags: [], difficulty: 1, evidence: [ev("k1", "not in the chunk")] },
  ],
} as unknown as StudyContent;

function record(overrides: Partial<EvalJobRecord>): EvalJobRecord {
  return {
    fixtureId: fixture.id,
    category: "en",
    kind: "flashcards",
    artifactId: "study-eval-r-en-sample-flashcards",
    status: "ready",
    errorCode: null,
    errorMessage: null,
    errorDetails: null,
    durationMs: 30_000,
    mode: "single",
    stats: { requested: 2, kept: 2, dropped: {}, groups: 1, tokensEstimated: 100 },
    content: cards,
    calls: [],
    judge: {
      verdicts: [
        { itemId: "c_1", kind: "flashcards", answerable: true, faithful: true, invalid: false, notes: [] },
        { itemId: "c_2", kind: "flashcards", answerable: false, faithful: false, invalid: false, notes: [] },
      ],
      skippedWithoutEvidence: 0,
    },
    ...overrides,
  };
}

const usage = (operation: string, key: string, costUsd: number, inputTokens = 0): UsageRecord => ({
  operation,
  feature: "chat",
  idempotencyKey: key,
  referenceId: null,
  profileAlias: "chat-default",
  modelAlias: "chat-default",
  providerModel: "model-x",
  inputTokens,
  outputTokens: 10,
  cacheReadTokens: 0,
  costUsd,
  costSource: "price_book",
});

describe("study evaluation report", () => {
  const summary = summarizeStudyEval({
    runId: "r",
    fixtures: new Map([[fixture.id, fixture]]),
    seeded: new Map([[fixture.id, seeded]]),
    records: [
      record({}),
      record({
        kind: "quiz",
        artifactId: "study-eval-r-en-sample-quiz",
        status: "failed",
        errorCode: "GENERATION_QUALITY_TOO_LOW",
        content: null,
        stats: null,
        mode: null,
        judge: null,
      }),
    ],
    usage: [
      usage("study.flashcards.generate", "study:study-eval-r-en-sample-flashcards:v1:gen:0", 0.01, 150),
      usage("study.quiz.generate", "study:study-eval-r-en-sample-quiz:v1:gen:0", 0.02),
      usage("study.eval.judge", "study-eval:r:judge:x", 0.005),
    ],
    generationModel: "chat-default → model-x",
    judgeModel: "chat-default → model-x",
  });
  const gate = (id: string) => summary.gates.find((entry) => entry.id === id)!;

  test("measures each gate from the records", () => {
    assert.equal(gate("anchoring").value, "50.0% (1/2)");
    assert.equal(gate("anchoring").pass, false);
    assert.equal(gate("job-failure").value, "50.0% (1/2)");
    assert.equal(gate("injection").pass, false);
    assert.equal(gate("coverage").value, "100.0% (2/2)");
    assert.equal(gate("answerability").value, "50.0% (1/2)");
    assert.equal(gate("latency-single").pass, true);
  });

  test("never passes a gate it could not measure", () => {
    assert.equal(gate("anchoring-cross-language").pass, null);
    assert.equal(gate("coverage-mindmap").pass, null);
    assert.equal(gate("kappa").pass, null);
    assert.equal(gate("latency-mapreduce").pass, null);
  });

  test("attributes cost to jobs and the judge, and compares input with the estimate", () => {
    const byKind = Object.fromEntries(summary.usage.byKind.map((entry) => [entry.kind, entry.costUsd]));
    assert.deepEqual(byKind, { flashcards: 0.01, quiz: 0.02, mindmap: 0, judge: 0.005 });
    assert.equal(summary.usage.estimateRatio, 1.5);
    assert.deepEqual(
      summary.jobsTable.map((job) => job.costUsd),
      [0.01, 0.02],
    );
  });

  test("warns when the judge is the generating model", () => {
    assert.equal(summary.judgeIsGenerationModel, true);
    assert.match(renderStudyEvalMarkdown(summary), /The judge is the same model as the generator/);
  });
});
