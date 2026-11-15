import { createHash } from "node:crypto";

/** The fingerprint of a source's text, used to tell whether it changed. */
export function computeContentHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
