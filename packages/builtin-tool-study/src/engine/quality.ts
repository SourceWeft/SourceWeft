import {
  DIFFICULTY_SKEW_SHARE,
  MIN_KEEP_ITEMS,
  MIN_KEEP_RATIO,
} from "./constants";
import { StudyGenerationError } from "./types";

/** Items a generation must keep for `requested`: 60%, and at least three. */
export function minimumKept(requested: number): number {
  return Math.max(
    Math.ceil(requested * MIN_KEEP_RATIO),
    Math.min(MIN_KEEP_ITEMS, requested),
  );
}

/**
 * A generation that kept too little is not published as a partial result. The
 * failure carries how many items the model wrote and why the rest were
 * dropped, so a shortfall can be told apart from a validation loss.
 */
export function assertRetention(input: {
  kept: number;
  requested: number;
  generated?: number;
  dropped?: Readonly<Record<string, number>>;
}) {
  const minimum = minimumKept(input.requested);
  if (input.kept < minimum) {
    throw new StudyGenerationError(
      "GENERATION_QUALITY_TOO_LOW",
      `Only ${input.kept} of ${input.requested} requested items passed validation (need ${minimum})`,
      {
        kept: input.kept,
        requested: input.requested,
        minimum,
        ...(input.generated === undefined ? {} : { generated: input.generated }),
        ...(input.dropped ? { dropped: { ...input.dropped } } : {}),
      },
    );
  }
}

/** True when one difficulty holds more than 85% of the items. Recorded only. */
export function difficultySkewed(difficulties: readonly number[]): boolean {
  if (difficulties.length === 0) return false;
  const counts = new Map<number, number>();
  for (const difficulty of difficulties) {
    counts.set(difficulty, (counts.get(difficulty) ?? 0) + 1);
  }
  const largest = Math.max(...counts.values());
  return largest / difficulties.length > DIFFICULTY_SKEW_SHARE;
}
