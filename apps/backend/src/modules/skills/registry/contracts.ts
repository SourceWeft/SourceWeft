import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Wire contracts + pure helpers for the skill-registry submit pipeline
 * (docs/architecture/skill-registry-index.md §3, build phase R1). Kept free of
 * DB/IO imports so the license/slug logic — which the ingest pipeline (R2) and
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

// --- License tier resolver (§3 Stage 3 / §5.5) -------------------------------

export type LicenseTier = "permissive" | "copyleft" | "unknown";

/**
 * Maps a declared license (SPDX id or free text) to the surfacing tier that
 * gates catalog-wide visibility (§5.5). This is a *legal* control, not a
 * cosmetic one:
 *   - `permissive` (MIT/Apache/BSD/ISC/CC-BY) → may auto-publish; attribution is
 *     satisfied at the index level.
 *   - `copyleft` (GPL/LGPL/MPL/CC-BY-SA) → held for review before catalog-wide
 *     surfacing.
 *   - `unknown` (no LICENSE / AGPL / anything unrecognized) → never auto-surface.
 *
 * Two ordering hazards drive the structure:
 *   1. AGPL is grouped with `unknown`, NOT `copyleft` — its network-use trigger
 *      against a hosted SaaS is exactly the obligation we won't auto-accept — and
 *      "AGPL" contains "GPL", so it MUST be matched before the GPL rule.
 *   2. CC-BY-SA (share-alike, copyleft) contains "CC-BY" (permissive), so the
 *      copyleft rule MUST run before the permissive rule.
 * Everything unmatched falls through to `unknown` (fail-closed): a license we
 * can't positively place never auto-surfaces.
 */
export function resolveLicenseTier(
  license: string | null | undefined,
): LicenseTier {
  const normalized = (license ?? "").trim().toUpperCase();
  // No LICENSE = all-rights-reserved (§5.5): index the pointer, never surface.
  if (normalized.length === 0) {
    return "unknown";
  }

  // (1) AGPL / Affero first — before the generic GPL match below.
  if (normalized.includes("AGPL") || normalized.includes("AFFERO")) {
    return "unknown";
  }

  // (2) Copyleft before permissive so CC-BY-SA isn't read as CC-BY. Substring
  // matching (not \b-anchored) so real-world spellings — "GPLv3", "0BSD",
  // "MIT-0" — classify correctly.
  if (
    normalized.includes("GPL") || // GPL, LGPL (AGPL already returned above)
    normalized.includes("MPL") ||
    normalized.includes("MOZILLA PUBLIC LICENSE") ||
    normalized.includes("GENERAL PUBLIC LICENSE") ||
    normalized.includes("CC-BY-SA") ||
    normalized.includes("CC BY-SA") ||
    normalized.includes("SHAREALIKE") ||
    normalized.includes("SHARE-ALIKE")
  ) {
    return "copyleft";
  }

  if (
    normalized.includes("MIT") ||
    normalized.includes("APACHE") ||
    normalized.includes("BSD") ||
    normalized.includes("ISC") ||
    normalized.includes("CC-BY") ||
    normalized.includes("CC BY") ||
    normalized.includes("CREATIVE COMMONS ATTRIBUTION")
  ) {
    return "permissive";
  }

  return "unknown";
}

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
