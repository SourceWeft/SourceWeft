/**
 * The review queue's page cursor, kept apart from the queries so it can be
 * read and checked without a database.
 */

/** Where a page ended: the last entry's time (to the millisecond) and id. */
export type RegistryReviewCursor = { createdAt: Date; id: string };

export function encodeRegistryReviewCursor(
  cursor: RegistryReviewCursor,
): string {
  return Buffer.from(
    JSON.stringify([cursor.createdAt.toISOString(), cursor.id]),
  ).toString("base64url");
}

/** `null` for anything that is not a cursor this module handed out. */
export function decodeRegistryReviewCursor(
  value: string,
): RegistryReviewCursor | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [at, id] = parsed;
    if (typeof at !== "string" || typeof id !== "string" || !id) return null;
    const createdAt = new Date(at);
    return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id };
  } catch {
    return null;
  }
}
