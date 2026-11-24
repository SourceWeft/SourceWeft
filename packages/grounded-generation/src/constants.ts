/**
 * Scale bounds of one grounded generation. Code constants, not settings: they
 * change with a code review, never with a deployment variable.
 */

/** At or below this many estimated input tokens a single model call is made. */
export const SINGLE_PASS_MAX_INPUT_TOKENS = 40_000;
/** Map-reduce groups aim for this size... */
export const GROUP_TARGET_TOKENS = 7_000;
/** ...never exceed this one (a single oversized chunk is its own group)... */
export const GROUP_MAX_TOKENS = 9_000;
/** ...and a group smaller than this is merged with a neighbour. */
export const GROUP_MIN_TOKENS = 1_500;
/** Larger selections are refused, never truncated. */
export const MAX_TOTAL_INPUT_TOKENS = 300_000;
