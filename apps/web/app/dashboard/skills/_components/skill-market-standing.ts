import {
  parseSkillClaimRepo,
  type OwnerSkillListing,
  type SkillClaimRepository,
  type SkillMarketClaim,
  type SkillMarketStanding,
} from "@sourceweft/contracts";

import type { useTranslations } from "next-intl";

/** The categories route accepts 1–5 slugs. */
export const SKILL_CATEGORY_LIMIT = 5;

export type SkillStandingKind =
  "public" | "withdrawn" | "ownerPrivate" | "restricted";

/**
 * `withdrawn` = an admin took it off the market; `ownerPrivate` = its author
 * (the claimant of its repository) keeps it private. Either way the auto-listing pass is held
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
 * The author's switch on a claimed skill. "Allowed" is not "listed": lifting your own hold lets the
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
 * no known repository. Only the verified claimant gets the removal action.
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

/**
 * `owner/repo` of a community skill's GitHub source URL
 * (`https://github.com/owner/repo/tree/<sha>/<path>`), lowercased the way
 * claims store it; null for anything else. What an admin grants a claim on.
 */
export function claimRepoOfSourceUrl(sourceUrl: string | null | undefined) {
  const match = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)/.exec(
    sourceUrl ?? "",
  );
  const parsed = match
    ? parseSkillClaimRepo(`${match[1]}/${(match[2] ?? "").replace(/\.git$/, "")}`)
    : null;
  return parsed ? `${parsed.owner}/${parsed.name}` : null;
}

/** Where "Claim this repository" goes. */
export function claimPageHref(repo: string) {
  return `/dashboard/skills/claim?repo=${encodeURIComponent(repo)}`;
}

/**
 * The author-facing message for a failed claim request. `t` is the
 * `dashboardSkillsClaim` translator; an unknown code gets the fallback.
 */
export function claimErrorMessage(
  error: unknown,
  t: ReturnType<typeof useTranslations>,
  fallback: string = t("errors.fallback"),
): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (
    typeof code === "string" &&
    /^[A-Z_]+$/.test(code) &&
    t.has(`errors.${code}`)
  ) {
    return t(`errors.${code}`);
  }
  return fallback;
}
