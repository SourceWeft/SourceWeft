/**
 * Error text that is safe to persist or log whole. Two things make a raw
 * `error.message` unsafe: drizzle's `DrizzleQueryError` message is
 * `Failed query: <sql>\nparams: <every bound value>`, which for a bulk insert
 * runs to megabytes (one such line per attempt rotated a worker's log away),
 * and any message can be arbitrarily long. The query error is rendered from
 * its parts, never its parameter values; everything is then capped.
 */

/** Longest message or stack a log line or a row may carry. */
export const MAX_ERROR_TEXT_CHARS = 4096;
/** How much of a failed statement's SQL is kept: enough to name the table. */
const MAX_QUERY_HEAD_CHARS = 2000;

type QueryErrorLike = {
  query: string;
  params: unknown[];
  cause?: unknown;
};

function isQueryErrorLike(error: unknown): error is QueryErrorLike {
  if (!error || typeof error !== "object") return false;
  const candidate = error as Partial<QueryErrorLike>;
  return typeof candidate.query === "string" && Array.isArray(candidate.params);
}

/** `text` cut to `max` characters, saying how much was left out. */
export function truncateErrorText(
  text: string,
  max = MAX_ERROR_TEXT_CHARS,
): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
}

/**
 * The message to record for `error`: a failed query by its SQL head and the
 * number of parameters it bound (plus what the database said), anything else
 * by its own message, capped either way.
 */
export function safeErrorMessage(error: unknown): string {
  if (isQueryErrorLike(error)) {
    const cause =
      error.cause instanceof Error
        ? error.cause.message
        : typeof error.cause === "string"
          ? error.cause
          : null;
    const head = truncateErrorText(error.query, MAX_QUERY_HEAD_CHARS);
    const text = `Failed query: ${head} (${error.params.length} params)`;
    return truncateErrorText(cause ? `${text}: ${cause}` : text);
  }
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : String(error);
  return truncateErrorText(message);
}

/**
 * The stack to record for `error`. A stack begins with the message, so a
 * query error's stack carries its parameters too: it is rebuilt from the safe
 * message and the frames, then capped like the message.
 */
export function safeErrorStack(error: Error): string | undefined {
  if (error.stack === undefined) return undefined;
  if (!isQueryErrorLike(error)) return truncateErrorText(error.stack);
  const frames = error.stack
    .split("\n")
    .filter((line) => /^\s+at\s/.test(line));
  return truncateErrorText(
    [`${error.name}: ${safeErrorMessage(error)}`, ...frames].join("\n"),
  );
}
