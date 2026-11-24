import { createHash } from "node:crypto";

/** A double click within this window opens the same artifact once. */
export const GROUNDED_REQUEST_DEDUPE_WINDOW_MS = 5 * 60_000;

/** JSON with sorted keys and no `undefined` members, for hashing requests. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * "The artifact for this request": `prefix:` and the hash of the request's
 * material within one dedupe window. Requests that differ in any member of
 * `material` get different keys.
 */
export function groundedRequestKey(
  prefix: string,
  material: Record<string, unknown>,
  now = Date.now(),
): string {
  const window = Math.floor(now / GROUNDED_REQUEST_DEDUPE_WINDOW_MS);
  const hash = createHash("sha256")
    .update(stableJson({ ...material, window }))
    .digest("hex")
    .slice(0, 40);
  return `${prefix}:${hash}`;
}

/** Where a request's artifact stands when the request returns. */
export type GroundedRequestArtifactStatus = "pending" | "running" | "ready";

/**
 * The status a request reports for its artifact: a new one is always
 * `pending`; a reused one reports its row's status (anything but running or
 * ready, read in a race with a failure, still counts as pending).
 */
export function groundedRequestArtifactStatus(
  reused: boolean,
  rowStatus: string | null | undefined,
): GroundedRequestArtifactStatus {
  if (!reused) return "pending";
  return rowStatus === "ready" || rowStatus === "running" ? rowStatus : "pending";
}
