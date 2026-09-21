import type {
  OwnerSkillListing,
  SkillClaimRepository,
  SkillMarketClaim,
  SkillMarketStanding,
} from "@sourceweft/contracts";

import { skillsClaimCopy } from "./skills-claim-copy";

/** The categories route accepts 1–5 slugs. */
export const SKILL_CATEGORY_LIMIT = 5;

export type SkillStandingKind =
  "public" | "withdrawn" | "ownerPrivate" | "restricted";

/**
 * `withdrawn` = an admin took it off the market; `ownerPrivate` = the person
 * who imported it keeps it private. Either way the auto-listing pass is held
 * off it. `restricted` = simply not listed (yet). A public skill is public
 * whatever its hold flag says.
 */
export function skillStandingKind(
  standing: Pick<SkillMarketStanding, "visibility" | "listingHold"> &
    Partial<Pick<SkillMarketStanding, "listingHoldBy">>,
): SkillStandingKind {
  if (standing.visibility === "public") return "public";
  if (!standing.listingHold) return "restricted";
  return standing.listingHoldBy === "owner" ? "ownerPrivate" : "withdrawn";
}

/**
 * The owner's switch. "Allowed" is not "listed": lifting your own hold lets the
 * usual rules decide, which for a clean skill means listed within minutes and
 * for a flagged one means an admin looks first. An admin's hold locks it.
 */
export function ownerListingView(
  listing: Pick<OwnerSkillListing, "listed" | "heldBy">,
): {
  allowed: boolean;
  locked: boolean;
  state: "listed" | "pending" | "private" | "heldByAdmin";
} {
  if (listing.heldBy === "admin") {
    return { allowed: false, locked: true, state: "heldByAdmin" };
  }
  if (listing.heldBy === "owner") {
    return { allowed: false, locked: false, state: "private" };
  }
  return {
    allowed: true,
    locked: false,
    state: listing.listed ? "listed" : "pending",
  };
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

/**
 * The author's claim on a skill's repository, from the admin's standing. The
 * route adds `claim`; an older backend without it reads as unclaimed.
 */
export function standingClaim(
  standing: SkillMarketStanding & { claim?: SkillMarketClaim | null },
): SkillMarketClaim | null {
  return standing.claim ?? null;
}

export type SkillClaimPanelView =
  | { kind: "hidden" }
  | { kind: "claimedByYou"; claimId: string | null; repo: string }
  | { kind: "claimedByAuthor"; repo: string }
  | { kind: "unclaimed"; repo: string };

/**
 * What the panel on a community skill's page offers. Hidden when the skill has
 * no known repository. Only the verified claimant gets the removal action;
 * their pending claim still reads as unclaimed, with a link back to finish it.
 */
export function claimPanelView(
  repository: SkillClaimRepository | null,
): SkillClaimPanelView {
  if (!repository) return { kind: "hidden" };
  if (repository.claimedBy === "you") {
    return {
      kind: "claimedByYou",
      claimId:
        repository.viewerClaim?.status === "verified"
          ? repository.viewerClaim.id
          : null,
      repo: repository.repo,
    };
  }
  if (repository.claimedBy === "someone") {
    return { kind: "claimedByAuthor", repo: repository.repo };
  }
  return { kind: "unclaimed", repo: repository.repo };
}

/** Where "Claim this repository" goes. */
export function claimPageHref(repo: string) {
  return `/dashboard/skills/claim?repo=${encodeURIComponent(repo)}`;
}

/** The author-facing message for a failed claim request. */
export function claimErrorMessage(
  error: unknown,
  fallback: string = skillsClaimCopy.errors.fallback,
): string {
  const code = (error as { code?: unknown } | null)?.code;
  const messages: Record<string, string> = skillsClaimCopy.errors;
  if (typeof code === "string" && code !== "fallback" && messages[code]) {
    return messages[code];
  }
  return fallback;
}
