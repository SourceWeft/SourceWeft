import { describe, expect, it } from "vitest";

import {
  canSaveSkillCategories,
  claimErrorMessage,
  claimPageHref,
  claimPanelView,
  claimRepoOfSourceUrl,
  SKILL_CATEGORY_LIMIT,
  skillStandingKind,
  standingClaim,
  toggleSkillCategory,
  ownerListingView,
} from "./skill-market-standing";
import { skillsClaimCopy } from "./skills-claim-copy";

describe("skillStandingKind", () => {
  it("tells listed, withdrawn and simply-unlisted apart", () => {
    expect(
      skillStandingKind({ visibility: "public", listingHold: false }),
    ).toBe("public");
    expect(
      skillStandingKind({ visibility: "restricted", listingHold: true }),
    ).toBe("withdrawn");
    expect(
      skillStandingKind({ visibility: "restricted", listingHold: false }),
    ).toBe("restricted");
  });

  it("reads a public skill as public even with a stale hold flag", () => {
    expect(skillStandingKind({ visibility: "public", listingHold: true })).toBe(
      "public",
    );
  });
});

describe("toggleSkillCategory", () => {
  it("adds and removes a slug without mutating the input", () => {
    const selected = ["writing"];
    expect(toggleSkillCategory(selected, "finance")).toEqual([
      "writing",
      "finance",
    ]);
    expect(toggleSkillCategory(selected, "writing")).toEqual([]);
    expect(selected).toEqual(["writing"]);
  });

  it("never grows past the limit, but can still shrink at it", () => {
    const full = Array.from(
      { length: SKILL_CATEGORY_LIMIT },
      (_, index) => `c${index}`,
    );
    expect(toggleSkillCategory(full, "one-more")).toEqual(full);
    expect(toggleSkillCategory(full, "c0")).toHaveLength(
      SKILL_CATEGORY_LIMIT - 1,
    );
  });
});

describe("canSaveSkillCategories", () => {
  it("needs between one and five categories", () => {
    expect(canSaveSkillCategories(["a"], [])).toBe(false);
    expect(canSaveSkillCategories([], ["a", "b", "c", "d", "e", "f"])).toBe(
      false,
    );
    expect(canSaveSkillCategories([], ["a"])).toBe(true);
  });

  it("needs an actual change, whatever the order", () => {
    expect(canSaveSkillCategories(["a", "b"], ["b", "a"])).toBe(false);
    expect(canSaveSkillCategories(["a", "b"], ["a", "c"])).toBe(true);
    expect(canSaveSkillCategories(["a", "b"], ["a"])).toBe(true);
  });
});

describe("skillStandingKind with an owner's hold", () => {
  it("tells an owner keeping a skill private from an admin's withdrawal", () => {
    expect(
      skillStandingKind({
        visibility: "restricted",
        listingHold: true,
        listingHoldBy: "owner",
      }),
    ).toBe("ownerPrivate");
    expect(
      skillStandingKind({
        visibility: "restricted",
        listingHold: true,
        listingHoldBy: "admin",
      }),
    ).toBe("withdrawn");
  });
});

describe("ownerListingView", () => {
  it("separates allowed from listed, and locks under an admin's hold", () => {
    expect(ownerListingView({ listed: true, heldBy: null })).toEqual({
      allowed: true,
      locked: false,
      state: "listed",
    });
    // Allowed, but the pass (or a review) has not listed it yet.
    expect(ownerListingView({ listed: false, heldBy: null })).toEqual({
      allowed: true,
      locked: false,
      state: "pending",
    });
    expect(ownerListingView({ listed: false, heldBy: "owner" })).toEqual({
      allowed: false,
      locked: false,
      state: "private",
    });
    expect(ownerListingView({ listed: false, heldBy: "admin" })).toEqual({
      allowed: false,
      locked: true,
      state: "heldByAdmin",
    });
  });
});

describe("author claims", () => {
  const repository = {
    repo: "ada/skills",
    skillCount: 2,
    ownerType: "User" as const,
    claimedBy: null,
    viewerClaim: null,
    accountMethod: { available: true, reason: null },
  };
  const verified = {
    id: "claim-1",
    repo: "ada/skills",
    method: "github_account" as const,
    status: "verified" as const,
    createdAt: "2026-09-21T00:00:00.000Z",
    verifiedAt: "2026-09-21T00:00:00.000Z",
  };

  it("offers the claim link until someone has claimed the repository", () => {
    expect(claimPanelView(null)).toEqual({ kind: "hidden" });
    expect(claimPanelView(repository)).toEqual({
      kind: "unclaimed",
      repo: "ada/skills",
    });
    expect(
      claimPanelView({ ...repository, claimedBy: "someone" }),
    ).toEqual({ kind: "claimedByAuthor", repo: "ada/skills" });
  });

  it("gives removal only to the verified claimant", () => {
    expect(
      claimPanelView({
        ...repository,
        claimedBy: "you",
        viewerClaim: verified,
      }),
    ).toEqual({ kind: "claimedByYou", claimId: "claim-1", repo: "ada/skills" });
  });

  it("finds the repository an admin grants a claim on from the source URL", () => {
    expect(
      claimRepoOfSourceUrl(
        "https://github.com/Acme/Skills/tree/0123456789abcdef/skills/pdf",
      ),
    ).toBe("acme/skills");
    expect(claimRepoOfSourceUrl("https://github.com/acme/skills.git")).toBe(
      "acme/skills",
    );
    expect(claimRepoOfSourceUrl("https://gitlab.com/acme/skills")).toBeNull();
    expect(claimRepoOfSourceUrl("https://github.com/acme")).toBeNull();
    expect(claimRepoOfSourceUrl(null)).toBeNull();
  });

  it("tells an organization's author to ask an admin", () => {
    expect(
      claimErrorMessage({ code: "SKILL_CLAIM_ORGANIZATION_REPO" }),
    ).toMatch(/admin.*support@sourceweft\.com/);
  });

  it("links to the claim page with the repository", () => {
    expect(claimPageHref("ada/skills")).toBe(
      "/dashboard/skills/claim?repo=ada%2Fskills",
    );
  });

  it("reads the claim off the standing, absent on an older backend", () => {
    const base = {
      skillId: "s",
      slug: "s",
      visibility: "public" as const,
      listingHold: false,
      listingHoldBy: null,
      verified: false,
      featured: false,
      featuredSetBy: null,
      categorySlugs: [],
      installCount: 0,
      listedAt: null,
    };
    expect(standingClaim(base)).toBeNull();
    const claim = {
      claimId: "claim-1",
      userId: "u",
      method: "admin_grant" as const,
      verifiedAt: null,
    };
    expect(standingClaim({ ...base, claim })).toEqual(claim);
  });

  it("explains a refusal by its code, and falls back otherwise", () => {
    expect(claimErrorMessage({ code: "SKILL_REPO_ALREADY_CLAIMED" })).toBe(
      skillsClaimCopy.errors.SKILL_REPO_ALREADY_CLAIMED,
    );
    expect(claimErrorMessage({ code: "SOMETHING_ELSE" })).toBe(
      skillsClaimCopy.errors.fallback,
    );
    expect(claimErrorMessage(new Error("boom"), "Custom")).toBe("Custom");
    expect(claimErrorMessage({ code: "fallback" }, "Custom")).toBe("Custom");
  });
});
