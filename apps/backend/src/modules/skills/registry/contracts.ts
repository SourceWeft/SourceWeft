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
 * plus the skill's own frontmatter `name` (§2): `gh-<owner>-<repo>-<name>`,
 * always within `[a-z0-9-]`.
 *
 * The slug is not just a database key: it becomes the skill's `name` in the
 * runtime descriptor, the `/skills/<name>/` mount segment, and the label the
 * model sees in its available-skills list. So it is built to be READ, from the
 * three parts a person would use to identify the skill — which is also how the
 * rest of the ecosystem addresses skills (LobeHub's `owner-repo`). An opaque
 * digest would satisfy uniqueness while telling the model nothing.
 *
 * A repo may ship many skills, and `name` is what the agentskills.io spec makes
 * the skill's identity, so `name` is what disambiguates them here. Two skills in
 * one repo declaring the same `name` therefore collide — that repo is malformed
 * by the spec, and the submit loop skips the duplicate with an explicit reason
 * rather than silently overwriting the first. `skill_definitions_slug_uq` is the
 * final backstop.
 */
export function deriveRegistrySlug(
  owner: string,
  repo: string,
  name: string,
): string {
  const base = `gh-${sanitizeSlugSegment(owner)}-${sanitizeSlugSegment(repo)}`;
  const skill = sanitizeSlugSegment(name);
  return skill.length > 0 ? `${base}-${skill}` : base;
}
