import type { SkillMarketStanding } from "@sourceweft/contracts";

/** The categories route accepts 1–5 slugs. */
export const SKILL_CATEGORY_LIMIT = 5;

export type SkillStandingKind = "public" | "withdrawn" | "restricted";

/**
 * `withdrawn` = an admin took it off the market and the auto-listing pass is
 * held off it; `restricted` = simply not listed (yet). A public skill is public
 * whatever its hold flag says.
 */
export function skillStandingKind(
  standing: Pick<SkillMarketStanding, "visibility" | "listingHold">,
): SkillStandingKind {
  if (standing.visibility === "public") return "public";
  return standing.listingHold ? "withdrawn" : "restricted";
}

/** Adds or removes a slug, never growing past the limit. */
export function toggleSkillCategory(
  selected: readonly string[],
  slug: string,
): string[] {
  if (selected.includes(slug)) {
    return selected.filter((entry) => entry !== slug);
  }
  if (selected.length >= SKILL_CATEGORY_LIMIT) return [...selected];
  return [...selected, slug];
}

/** Worth sending: within 1–5 and actually different from what is saved. */
export function canSaveSkillCategories(
  saved: readonly string[],
  selected: readonly string[],
) {
  if (selected.length < 1 || selected.length > SKILL_CATEGORY_LIMIT) {
    return false;
  }
  if (saved.length !== selected.length) return true;
  const savedSet = new Set(saved);
  return selected.some((slug) => !savedSet.has(slug));
}
