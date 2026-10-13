/**
 * Identifier prefix for activity log lines. Eight characters are enough to
 * correlate a line with a row by hand without reproducing the full id in logs.
 */
export const LOG_ID_LENGTH = 8;

export function shortId(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.slice(0, LOG_ID_LENGTH);
}
