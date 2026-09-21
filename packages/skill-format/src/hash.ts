import { createHash } from "node:crypto";

/**
 * Content hash for skill material — the identity of a skill's bytes. The
 * registry records it per file at ingest, and anything that later receives the
 * same bytes (the sandbox stager, the CLI) checks it against that record, so
 * there is exactly one definition: lowercase hex sha256 over the raw bytes.
 * Text is hashed as its UTF-8 encoding.
 */
export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
