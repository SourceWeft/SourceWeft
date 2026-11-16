import {
  STUDY_LIMITS,
  type StudyKind,
  type StudyOptions,
} from "@sourceweft/contracts/study";
import { STUDY_SIZE_COUNTS } from "./constants";
import { estimateTokens } from "./corpus";
import { resolveOutputLanguage } from "./language";
import type { CorpusChunkInput, ResolvedStudyOptions } from "./types";

/**
 * Fills in what the request left open: the count from the size step (an
 * explicit count wins, capped per type), mixed difficulty, and the output
 * language from the sources or the UI locale.
 */
export function resolveStudyOptions(input: {
  kind: StudyKind;
  options?: StudyOptions;
  chunks: readonly Pick<CorpusChunkInput, "language" | "text">[];
  uiLocale: string;
}): ResolvedStudyOptions {
  const options = input.options ?? {};
  const count = Math.min(
    options.count ?? STUDY_SIZE_COUNTS[input.kind][options.size ?? "standard"],
    STUDY_LIMITS.maxCount[input.kind],
  );
  return {
    count,
    difficulty: options.difficulty ?? "mixed",
    language: resolveOutputLanguage({
      requested: options.language ?? null,
      chunks: input.chunks.map((chunk) => ({
        language: chunk.language,
        tokens: estimateTokens(chunk.text),
      })),
      uiLocale: input.uiLocale,
    }),
  };
}
