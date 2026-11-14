import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, expect, test } from "vitest";
import { assertGitIgnored } from "../../shared/git-ignore";
import {
  importLabels,
  parseLabelledCases,
  scoreLabels,
  suggestThresholds,
  wouldBeStrong,
  type LabelledCase,
} from "./anchoring-labels";

const repoRoot = resolve(import.meta.dirname, "../../../../..");
const scratch = resolve(repoRoot, ".local-eval", `test-${randomUUID()}`);
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function labelled(
  id: string,
  label: "supported" | "not",
  similarity: number,
  margin: number | null,
  outcome: string,
): LabelledCase {
  return {
    id,
    label,
    claim: "claim",
    passage: "passage",
    recorded: {
      similarity,
      margin,
      outcome,
      support: "weak",
      scripts: "cjk>latin",
    },
  };
}

const jsonl = (items: unknown[]) =>
  items.map((item) => JSON.stringify(item)).join("\n") + "\n";

test("only ignored paths are accepted for files that hold user content", async () => {
  await assertGitIgnored(resolve(scratch, "any.jsonl"));
  await assert.rejects(
    assertGitIgnored(resolve(repoRoot, "apps/backend/borderline.jsonl")),
    /not git-ignored/,
  );
  // Outside a repository there is nothing to rely on: refuse.
  await assert.rejects(
    assertGitIgnored(resolve(tmpdir(), "borderline.jsonl")),
    /not git-ignored/,
  );
});

test("a label file keeps labelled cases, counts unlabelled ones and rejects bad labels", () => {
  const good = labelled("a", "supported", 0.72, 0.3, "strong");
  const text = jsonl([good, { ...good, id: "b", label: null }]);
  const parsed = parseLabelledCases(text);
  assert.equal(parsed.labelled.length, 1);
  assert.equal(parsed.unlabelled, 1);
  assert.throws(
    () => parseLabelledCases(jsonl([{ ...good, label: "maybe" }])),
    /label must be/,
  );
  assert.throws(() => parseLabelledCases("not json\n"), /not valid JSON/);
});

test("importing merges labelled cases into the labelled set and refuses an unignored target", async () => {
  await mkdir(scratch, { recursive: true });
  const from = resolve(scratch, "export.jsonl");
  const into = resolve(scratch, "labelled.jsonl");
  await writeFile(
    from,
    jsonl([
      labelled("a", "supported", 0.72, 0.3, "strong"),
      { ...labelled("b", "not", 0.6, 0.2, "below_similarity"), label: null },
    ]),
  );
  const first = await importLabels({ from, into });
  assert.deepEqual(first, { imported: 1, unlabelled: 1, total: 1 });

  // A later label for the same case replaces the earlier one.
  await writeFile(
    from,
    jsonl([
      labelled("a", "not", 0.72, 0.3, "strong"),
      labelled("c", "supported", 0.8, 0.5, "strong"),
    ]),
  );
  assert.deepEqual(await importLabels({ from, into }), {
    imported: 2,
    unlabelled: 0,
    total: 2,
  });
  const stored = parseLabelledCases(await readFile(into, "utf8")).labelled;
  assert.equal(stored.find((item) => item.id === "a")?.label, "not");

  await assert.rejects(
    importLabels({
      from,
      into: resolve(repoRoot, "apps/backend/labelled.jsonl"),
    }),
    /not git-ignored/,
  );
});

test("the thresholds' own decision is reproduced from the recorded numbers", () => {
  const at = { similarity: 0.7, margin: 0.15 };
  assert.equal(
    wouldBeStrong(labelled("1", "supported", 0.8, 0.4, "strong"), at),
    true,
  );
  assert.equal(
    wouldBeStrong(labelled("2", "not", 0.65, 0.4, "below_similarity"), at),
    false,
  );
  assert.equal(
    wouldBeStrong(labelled("3", "not", 0.8, 0.05, "below_margin"), at),
    false,
  );
  // Figures that single one sentence out make a strong call below the margin.
  assert.equal(
    wouldBeStrong(labelled("4", "supported", 0.9, 0.02, "strong"), at),
    true,
  );
  // Rule-based rejections do not depend on the thresholds.
  assert.equal(
    wouldBeStrong(labelled("5", "not", 0.99, 0.9, "figures_missing"), {
      similarity: 0.5,
      margin: 0,
    }),
    false,
  );
  assert.equal(
    wouldBeStrong(labelled("6", "not", 0.99, 0.9, "direction_conflict"), {
      similarity: 0.5,
      margin: 0,
    }),
    false,
  );
});

test("precision and recall at the current thresholds, and a suggested pair", () => {
  const cases = [
    labelled("1", "supported", 0.8, 0.4, "strong"),
    labelled("2", "supported", 0.75, 0.3, "strong"),
    labelled("3", "not", 0.74, 0.2, "strong"),
    labelled("4", "supported", 0.66, 0.4, "below_similarity"),
    labelled("5", "not", 0.5, 0.4, "below_similarity"),
    labelled("6", "supported", 0.9, 0.05, "below_margin"),
  ];
  const score = scoreLabels(cases, { similarity: 0.7, margin: 0.15 });
  expect(score).toMatchObject({
    truePositive: 2,
    falsePositive: 1,
    falseNegative: 2,
  });
  assert.equal(score.precision, 2 / 3);
  assert.equal(score.recall, 0.5);

  // Two pairs find 3 of the 4 supported cases with no wrong call: similarity
  // 0.75 with a margin of 0.05, or similarity 0.66 with a margin above case 3's.
  const suggestion = suggestThresholds(cases, 1)!;
  assert.equal(suggestion.precision, 1);
  assert.equal(suggestion.recall, 0.75);
  // Whichever pair is chosen, it must clear case 3 and keep three supported cases.
  assert.equal(wouldBeStrong(cases[2]!, suggestion), false);
  // No pair can be right when the only case is a confident wrong call.
  assert.equal(
    suggestThresholds([labelled("x", "not", 0.9, 0.9, "strong")], 1),
    null,
  );
});
