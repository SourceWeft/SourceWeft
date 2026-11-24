import assert from "node:assert/strict";
import { test } from "vitest";
import { ASSISTANT_LIMITS } from "../limits";
import {
  stripCitationMarkers,
  workerReportFeedText,
  workerReportText,
} from "./report-text";

test("citation markers are removed with the space before them", () => {
  assert.equal(
    stripCitationMarkers(
      "当前 LTS 为 v26.13.1，代号 \"Lithium\"[citation:c1]。\nIt ships yearly [citation:c2] [citation:c3].",
    ),
    "当前 LTS 为 v26.13.1，代号 \"Lithium\"。\nIt ships yearly.",
  );
});

test("a line that ends in a marker keeps no trailing space, and other brackets stay", () => {
  assert.equal(
    stripCitationMarkers("1) Version [citation:c1]\n2) See [notes] and [src]"),
    "1) Version\n2) See [notes] and [src]",
  );
});

test("a summary that is only markers is kept as written rather than emptied", () => {
  assert.equal(stripCitationMarkers("[citation:c1]"), "[citation:c1]");
});

test("the feed text is the summary, then the question as its own paragraph", () => {
  assert.equal(workerReportFeedText({ summary: "Done." }), "Done.");
  assert.equal(
    workerReportFeedText({ summary: "Two drafts.", question: "Which one?" }),
    "Two drafts.\n\nWhich one?",
  );
});

test("the feed text is capped at the feed's message limit", () => {
  const text = workerReportFeedText({
    summary: "x".repeat(ASSISTANT_LIMITS.feedMessageMax + 10),
  });
  assert.equal(text.length, ASSISTANT_LIMITS.feedMessageMax);
  assert.ok(text.endsWith("…"));
});

test("the Router's event text keeps the status and the question", () => {
  assert.equal(
    workerReportText({ status: "waiting", summary: "Two drafts.", question: "Which one?" }),
    "waiting: Two drafts.\nQuestion: Which one?",
  );
});
