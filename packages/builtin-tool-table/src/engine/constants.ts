/** Version stamp of the table prompts; bump it when a prompt changes meaning. */
export const TABLE_PROMPT_VERSION = "table-v1";

/** How many sources are filled in parallel while generating a table. */
export const FILL_CONCURRENCY = 4;

/** Largest share of unverified cells a filled table may have before it is rejected. */
export const MAX_UNVERIFIED_SHARE = 0.4;

/** Fewest columns kept from a column suggestion. */
export const SUGGEST_MIN_COLUMNS = 4;

/** Most columns kept from a column suggestion. */
export const SUGGEST_MAX_COLUMNS = 8;

/** Characters of each source summary shown to the column suggester. */
export const SUGGEST_SUMMARY_CHARS = 1_200;

/** Wall-clock limit of one table generation job, in milliseconds. */
export const TABLE_JOB_TIMEOUT_MS = 20 * 60_000;

/** How many times a table generation job is attempted before it fails. */
export const TABLE_JOB_ATTEMPTS = 2;

/** Output budget of the column suggestion call. */
export const SUGGEST_MAX_OUTPUT_TOKENS = 800;

/** Output budget of one fill call: a base plus a share per requested column. */
export const FILL_BASE_OUTPUT_TOKENS = 300;
export const FILL_COLUMN_OUTPUT_TOKENS = 220;
export const FILL_MAX_OUTPUT_TOKENS = 4_000;

/** Output budget of the call that picks between disagreeing candidates. */
export const MERGE_MAX_OUTPUT_TOKENS = 100;

export function fillMaxTokens(columnCount: number): number {
  return Math.min(
    FILL_MAX_OUTPUT_TOKENS,
    FILL_BASE_OUTPUT_TOKENS + FILL_COLUMN_OUTPUT_TOKENS * columnCount,
  );
}
