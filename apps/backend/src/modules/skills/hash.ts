import { createHash } from "node:crypto";

/**
 * Content hash for skill material.
 *
 * Used as the identity of a skill's bytes — the checksum recorded against a
 * stored custom skill, the digest a builtin's content is compared against, and
 * the integrity check on a fetched registry bundle. Callers pass either the
 * decoded text or the raw bytes; both hash the same way, so both live here
 * rather than as two near-identical helpers.
 */
export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
