/**
 * Identifier prefix for activity log lines: enough to correlate with a row by
 * hand without reproducing the full id in logs.
 */
export function shortId(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.slice(0, 8);
}
