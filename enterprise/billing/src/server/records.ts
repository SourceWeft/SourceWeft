/**
 * Plain-object guards shared across the backend.
 *
 * "Plain object" here means a non-null `object` that is not an array. Arrays
 * are excluded on purpose: every caller wants to read named keys off an
 * `unknown` value, and an array would silently satisfy `typeof x === "object"`
 * while indexing by key yields `undefined`.
 *
 * These deliberately do NOT validate the values inside the record. They are a
 * shape check, not a schema; anything that needs value-level guarantees should
 * reach for zod instead.
 */

/** Narrow an unknown value to a plain object, or `null` when it is not one. */
export function toObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

/** Type predicate form of {@link toObjectRecord}, for use in conditions. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
