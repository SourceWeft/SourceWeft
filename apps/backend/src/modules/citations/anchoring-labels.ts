import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { assertGitIgnored } from "../../shared/git-ignore";
import {
  SEMANTIC_MIN_MARGIN,
  SEMANTIC_MIN_SIMILARITY,
} from "./semantic-anchoring";

/**
 * Human labels for borderline by-meaning decisions (#516), and the precision
 * and recall they give at a pair of thresholds. Pure file work: no database,
 * so the eval script can use it without a connection. The files hold user
 * content and may only live at git-ignored paths.
 */

export type BorderlineCase = {
  /** The citation row id. */
  id: string;
  /** Human label: "supported" when the passage supports the claim, else "not". */
  label: "supported" | "not" | null;
  claim: string;
  passage: string;
  recorded: {
    similarity: number;
    margin: number | null;
    outcome: string;
    support: string;
    scripts: string;
  };
};

export type LabelledCase = BorderlineCase & {
  label: "supported" | "not";
};

function parseLines(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as Partial<BorderlineCase>;
      } catch {
        throw new Error(`Line ${index + 1} is not valid JSON`);
      }
    });
}

function isLabelled(item: Partial<BorderlineCase>): item is LabelledCase {
  return (
    typeof item.id === "string" &&
    (item.label === "supported" || item.label === "not") &&
    typeof item.recorded?.similarity === "number" &&
    typeof item.recorded?.outcome === "string"
  );
}

/**
 * The labelled cases of a file. A line with a label other than
 * "supported"/"not" (and not null) is an error; unlabelled lines are counted
 * and left out.
 */
export function parseLabelledCases(text: string) {
  const labelled: LabelledCase[] = [];
  let unlabelled = 0;
  for (const [index, item] of parseLines(text).entries()) {
    if (
      item.label === null ||
      item.label === undefined ||
      item.label === ("" as never)
    ) {
      unlabelled += 1;
    } else if (isLabelled(item)) {
      labelled.push(item);
    } else {
      throw new Error(
        `Line ${index + 1}: the label must be "supported" or "not" and the case must keep its recorded numbers`,
      );
    }
  }
  return { labelled, unlabelled };
}

/**
 * Merges labels from an exported file into the labelled set (kept in a
 * git-ignored file). A later label for the same citation wins.
 */
export async function importLabels(input: { from: string; into: string }) {
  await assertGitIgnored(input.into);
  const incoming = parseLabelledCases(await readFile(input.from, "utf8"));
  const existing = await readFile(input.into, "utf8").then(
    (text) => parseLabelledCases(text).labelled,
    () => [] as LabelledCase[],
  );
  const merged = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming.labelled) merged.set(item.id, item);
  await mkdir(dirname(input.into), { recursive: true });
  await writeFile(
    input.into,
    [...merged.values()].map((item) => JSON.stringify(item)).join("\n") + "\n",
  );
  return {
    imported: incoming.labelled.length,
    unlabelled: incoming.unlabelled,
    total: merged.size,
  };
}

export type Thresholds = { similarity: number; margin: number };

/**
 * Would the by-meaning pass call this case strong under these thresholds?
 * Reasons that do not depend on the thresholds (figures, direction, bounds,
 * failures) are taken as recorded. Approximation: a case rejected only by a
 * threshold is assumed to clear the figure and direction rules at a lower one.
 */
export function wouldBeStrong(item: LabelledCase, at: Thresholds) {
  const { outcome, similarity, margin } = item.recorded;
  if (
    outcome === "figures_missing" ||
    outcome === "direction_conflict" ||
    outcome === "over_budget" ||
    outcome === "embedding_failed"
  ) {
    return false;
  }
  if (similarity < at.similarity) return false;
  // A strong call below the margin was made on figures that single out one
  // sentence, a rule that does not look at the margin.
  if (outcome === "strong" && margin !== null && margin < SEMANTIC_MIN_MARGIN) {
    return true;
  }
  return margin === null || margin >= at.margin;
}

export type LabelScore = {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  precision: number | null;
  recall: number | null;
};

export function scoreLabels(
  cases: readonly LabelledCase[],
  at: Thresholds,
): LabelScore {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  for (const item of cases) {
    const strong = wouldBeStrong(item, at);
    const supported = item.label === "supported";
    if (strong && supported) truePositive += 1;
    else if (strong) falsePositive += 1;
    else if (supported) falseNegative += 1;
  }
  const called = truePositive + falsePositive;
  const actual = truePositive + falseNegative;
  return {
    truePositive,
    falsePositive,
    falseNegative,
    precision: called === 0 ? null : truePositive / called,
    recall: actual === 0 ? null : truePositive / actual,
  };
}

/**
 * The threshold pair with the best recall among those that keep precision at
 * or above `minPrecision` (a wrong highlight is worse than a missing one);
 * ties go to the pair nearest the current thresholds. Null when no pair
 * reaches the precision.
 */
export function suggestThresholds(
  cases: readonly LabelledCase[],
  minPrecision = 0.95,
): (Thresholds & LabelScore) | null {
  let best: (Thresholds & LabelScore & { distance: number }) | null = null;
  for (let s = 50; s <= 95; s += 1) {
    for (let m = 0; m <= 40; m += 1) {
      const at = { similarity: s / 100, margin: m / 100 };
      const score = scoreLabels(cases, at);
      if (score.precision === null || score.precision < minPrecision) continue;
      const recall = score.recall ?? 0;
      const distance =
        Math.abs(at.similarity - SEMANTIC_MIN_SIMILARITY) +
        Math.abs(at.margin - SEMANTIC_MIN_MARGIN);
      if (
        !best ||
        recall > (best.recall ?? 0) ||
        (recall === (best.recall ?? 0) && distance < best.distance)
      ) {
        best = { ...at, ...score, distance };
      }
    }
  }
  if (!best) return null;
  const { distance: _distance, ...result } = best;
  return result;
}

const fraction = (value: number | null) =>
  value === null ? "n/a" : value.toFixed(3);

export function formatLabelEvaluation(cases: readonly LabelledCase[]) {
  const supported = cases.filter((item) => item.label === "supported").length;
  const current = {
    similarity: SEMANTIC_MIN_SIMILARITY,
    margin: SEMANTIC_MIN_MARGIN,
  };
  const score = scoreLabels(cases, current);
  const suggestion = suggestThresholds(cases);
  const lines = [
    `Labelled cases: ${cases.length} (${supported} supported, ${cases.length - supported} not)`,
    `At the current thresholds (similarity ${current.similarity}, margin ${current.margin}):`,
    `  precision ${fraction(score.precision)}  recall ${fraction(score.recall)}  (TP ${score.truePositive}, FP ${score.falsePositive}, FN ${score.falseNegative})`,
  ];
  if (suggestion) {
    lines.push(
      `Suggested pair keeping precision >= 0.95: similarity ${suggestion.similarity}, margin ${suggestion.margin}`,
      `  precision ${fraction(suggestion.precision)}  recall ${fraction(suggestion.recall)}`,
    );
  } else {
    lines.push("No threshold pair reaches precision 0.95 on these labels.");
  }
  if (cases.length < 100) {
    lines.push(
      `Note: ${cases.length} labels is below the 100 needed before the thresholds should be changed; treat the suggestion as indicative only.`,
    );
  }
  return lines.join("\n");
}

export async function readLabelledCases(path: string) {
  return parseLabelledCases(await readFile(path, "utf8"));
}
