import { randomBytes } from "node:crypto";

/**
 * Public share slug. 16 random bytes (128 bits) as base64url — unguessable, so
 * knowing the URL is the only way in, and short enough to paste. This is the
 * sole capability for an unlisted link, so entropy is the security boundary.
 */
export function generateShareToken() {
  return randomBytes(16).toString("base64url");
}
