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
export { submitRegistrySkillResponseSchema } from "@sourceweft/contracts";
export type { SubmitRegistrySkillResponse } from "@sourceweft/contracts";

// --- Slug derivation (§2) ----------------------------------------------------

function sanitizeSlugSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // collapse any run of unsafe chars to one "-"
    .replace(/^-+|-+$/g, ""); // no leading/trailing hyphens
}

/** Legacy slug retained for existing pages; source identity is repository + root. */
export function deriveRegistrySlug(
  owner: string,
  repo: string,
  name: string,
  sourceRoot?: string,
  repositoryId?: string,
): string {
  const base = `gh-${sanitizeSlugSegment(owner)}-${sanitizeSlugSegment(repo)}`;
  const skill = sanitizeSlugSegment(name);
  const legacy = skill.length > 0 ? `${base}-${skill}` : base;
  if (sourceRoot === undefined) return legacy;
  const path = sanitizeSlugSegment(sourceRoot).slice(0, 80) || "root";
  return `${legacy}-${path}-${createHash("sha256")
    .update(repositoryId ? `${repositoryId}\0${sourceRoot}` : sourceRoot)
    .digest("hex")
    .slice(0, 16)}`;
}
