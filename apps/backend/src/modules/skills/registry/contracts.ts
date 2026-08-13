import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Wire contracts + pure helpers for the skill-registry submit pipeline
 * (docs/architecture/skill-registry-index.md §3, build phase R1). Kept free of
 * DB/IO imports so the slug logic — which the ingest pipeline (R2) and
 * catalog (R3) both depend on — stays trivially unit-testable.
 */

// --- Stage 1 submit (§3) -----------------------------------------------------

/**
 * `repoUrl` is deliberately just a non-empty string, not `z.url()`: the
 * authoritative parse is `normalizeGitHubSource` server-side (Stage 2), which
 * also accepts the `owner/repo` shorthand — a stricter URL schema here would
 * wrongly reject valid submissions. The github.com allowlist + traversal
 * stripping live there, not in the request shape.
 */
export const submitRegistrySkillRequestSchema = z.object({
  repoUrl: z.string().trim().min(1, "repoUrl is required"),
});
export type SubmitRegistrySkillRequest = z.infer<
  typeof submitRegistrySkillRequestSchema
>;

/**
 * `indexed` = clean scan → auto-published catalog entry; `queued` = flagged or
 * sticky (§4 triage) → held in the review queue. `slug` is the derived,
 * collision-safe key the UI can deep-link to; it may be absent when a
 * submission is rejected before a definition is upserted.
 */
export const submitRegistrySkillResponseSchema = z.object({
  status: z.enum(["indexed", "queued"]),
  slug: z.string().optional(),
});
export type SubmitRegistrySkillResponse = z.infer<
  typeof submitRegistrySkillResponseSchema
>;

// --- Slug derivation (§2) ----------------------------------------------------

function sanitizeSlugSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // collapse any run of unsafe chars to one "-"
    .replace(/^-+|-+$/g, ""); // no leading/trailing hyphens
}

/**
 * Derive the global-unique `skill_definitions.slug` from a GitHub identifier
 * (§2): `gh-<owner>-<repo>[-<8-hex subpath hash>]`, always within `[a-z0-9-]`.
 *
 * A single repo can ship many skills under different subpaths, so the subpath
 * must participate in the slug. It is folded in as an 8-hex hash of the RAW
 * (only leading/trailing "/" trimmed) subpath rather than its sanitized form:
 * sanitizing first would let distinct paths collide (`skills/a` and `skills-a`
 * both flatten to `skills-a`), whereas hashing the raw path keeps them distinct
 * while staying in the slug charset. The DB's `skill_definitions_slug_uq` index
 * is the final backstop for the residual owner/repo hyphen ambiguity.
 */
export function deriveRegistrySlug(
  owner: string,
  repo: string,
  subpath?: string,
): string {
  const base = `gh-${sanitizeSlugSegment(owner)}-${sanitizeSlugSegment(repo)}`;
  const normalizedSubpath = (subpath ?? "").replace(/^\/+|\/+$/g, "");
  if (normalizedSubpath.trim().length === 0) {
    return base;
  }
  const subpathHash = createHash("sha256")
    .update(normalizedSubpath)
    .digest("hex")
    .slice(0, 8);
  return `${base}-${subpathHash}`;
}
