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

/**
 * Payload field readers shared by the provider webhook translators. Each
 * reads one field off an already-parsed payload record and returns a usable
 * value or `null` — never throws, since a provider payload is untrusted
 * input.
 */

/** A trimmed-non-empty string at `record[key]`, else `null`. */
export function readString(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * A number at `record[key]`, else `null`. Only a `typeof` check: NaN and
 * Infinity pass through unchanged rather than being narrowed to `null`,
 * since a payload value never actually arrives as either from parsed JSON.
 */
export function readNumber(
  record: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = record?.[key];
  return typeof value === "number" ? value : null;
}

/**
 * A provider reference that shows up as either a bare id or an embedded
 * object with its own `id`, depending on the event (e.g. Creem's
 * `subscription`/`order`/`product` fields).
 */
export function readReferenceId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  return readString(toObjectRecord(value), "id");
}
