import assert from "node:assert/strict";
import test from "node:test";
import {
  RESEARCH_TOPIC_MAX_CHARS,
  researchRequestSchema,
  researchRunSchema,
} from "../src/source-research";

const readyRun = {
  id: "run-1",
  topic: "Solid state batteries",
  status: "ready",
  phase: "reporting",
  progress: { round: 2, searches: 6, pagesRead: 9, modelCalls: 14 },
  plan: ["market", "technology"],
  report: "Report body [1]",
  citations: [{ entryId: "e1", quote: "a quote", status: "verified" }],
  sources: [{ url: "https://example.com/a", title: "A", entryId: "e1" }],
  errorCode: null,
  createdAt: "2026-11-21T00:00:00.000Z",
  finishedAt: "2026-11-21T00:05:00.000Z",
};

test("research request rejects blank and oversized topics", () => {
  assert.equal(
    researchRequestSchema.safeParse({ topic: "   " }).success,
    false,
  );
  assert.equal(
    researchRequestSchema.safeParse({
      topic: "x".repeat(RESEARCH_TOPIC_MAX_CHARS + 1),
    }).success,
    false,
  );
  const ok = researchRequestSchema.parse({ topic: "  hello  " });
  assert.equal(ok.topic, "hello");
});

test("research run accepts a ready run with a verified citation", () => {
  const parsed = researchRunSchema.parse(readyRun);
  assert.equal(parsed.status, "ready");
  assert.equal(parsed.citations[0]?.status, "verified");
});

test("research run rejects an unknown error code", () => {
  assert.equal(
    researchRunSchema.safeParse({ ...readyRun, errorCode: "BOOM" }).success,
    false,
  );
});
