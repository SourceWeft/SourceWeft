import assert from "node:assert/strict";
import { test } from "vitest";
import { buildPlanPrompt, parsePlannedQueries } from "./planner";

test("queries are trimmed, distinct and capped", () => {
  const queries = parsePlannedQueries({
    queries: [
      "  solid state batteries  ",
      "Solid State Batteries",
      "",
      "battery recycling",
      "q3",
      "q4",
      "q5",
      "q6",
    ],
  });
  assert.deepEqual(queries, [
    "solid state batteries",
    "battery recycling",
    "q3",
    "q4",
    "q5",
  ]);
});

test("an unusable answer yields no queries", () => {
  assert.deepEqual(parsePlannedQueries({ queries: "x" }), []);
  assert.deepEqual(parsePlannedQueries(undefined), []);
  assert.deepEqual(parsePlannedQueries({ queries: ["  "] }), []);
});

test("the prompt carries the topic", () => {
  assert.ok(buildPlanPrompt("固态电池").user.includes("固态电池"));
});
