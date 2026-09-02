/**
 * Plain-object guards shared across the web app.
 *
 * "Plain object" here means a non-null `object` that is not an array. Arrays
 * are excluded on purpose: every caller wants to read named keys off an
 * `unknown` value (stream payloads, message metadata, tool output), and an
 * array would silently satisfy `typeof x === "object"` while indexing by key
 * yields `undefined`.
 *
 * These are a shape check, not a schema — they say nothing about the values
 * inside the record.
 */

/** Narrow an unknown value to a plain object, or `null` when it is not one. */
export function toObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

/** Read one key off an optional record. */
export function getRecordValue(
  record: Record<string, unknown> | undefined,
  key: string,
) {
  return record ? record[key] : undefined;
}
