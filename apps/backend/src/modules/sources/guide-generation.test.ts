import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildGuidePrompt,
  GUIDE_MAX_INPUT_CHARS,
  parseGuideContent,
} from "./guide-generation";

test("only the start of a long source is sent, and the prompt says so", () => {
  const content = "a".repeat(GUIDE_MAX_INPUT_CHARS + 500);
  const prompt = buildGuidePrompt({ title: "Report", content });
  assert.ok(prompt.user.includes("only its beginning is shown"));
  assert.equal(prompt.user.includes("a".repeat(GUIDE_MAX_INPUT_CHARS + 1)), false);
});

test("a short source is sent whole with no truncation note", () => {
  const prompt = buildGuidePrompt({ title: "Memo", content: "Short text." });
  assert.ok(prompt.user.includes("Short text."));
  assert.equal(prompt.user.includes("only its beginning"), false);
});

test("a usable answer is trimmed and capped", () => {
  const content = parseGuideContent({
    summary: "  A summary.  ",
    topics: Array.from({ length: 12 }, (_, index) => ` topic ${index} `),
    suggestedQuestions: ["Q1?", " ", "Q2?", "Q3?", "Q4?", "Q5?", "Q6?"],
  });
  assert.ok(content);
  assert.equal(content.summary, "A summary.");
  assert.equal(content.topics.length, 8);
  assert.equal(content.topics[0], "topic 0");
  assert.deepEqual(content.suggestedQuestions, ["Q1?", "Q2?", "Q3?", "Q4?", "Q5?"]);
});

test("an answer without a summary or questions is rejected", () => {
  assert.equal(
    parseGuideContent({ summary: " ", topics: [], suggestedQuestions: ["Q?"] }),
    null,
  );
  assert.equal(
    parseGuideContent({ summary: "S.", topics: [], suggestedQuestions: [] }),
    null,
  );
  assert.equal(parseGuideContent({ summary: "S." }), null);
  assert.equal(parseGuideContent(undefined), null);
});
