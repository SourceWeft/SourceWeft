/**
 * Content hash for skill material. The definition lives in
 * `@sourceweft/skill-format` because the CLI verifies downloaded bytes against
 * the hashes recorded here, and both sides must compute the same thing.
 */
export { sha256 } from "@sourceweft/skill-format";
