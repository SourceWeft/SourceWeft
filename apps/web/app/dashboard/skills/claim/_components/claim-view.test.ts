import { describe, expect, it } from "vitest";
import type {
  SkillClaimRepository,
  SkillRepoClaim,
} from "@sourceweft/contracts";

import {
  claimPageSearch,
  claimRepositoryPlan,
  claimRequestMailto,
  normalizeClaimRepo,
  sortClaims,
} from "./claim-view";

const verified: SkillRepoClaim = {
  id: "claim-2",
  repo: "ada/skills",
  method: "github_account",
  status: "verified",
  createdAt: "2026-09-20T00:00:00.000Z",
  verifiedAt: "2026-09-20T00:00:00.000Z",
};
const personal: SkillClaimRepository = {
  repo: "ada/skills",
  skillCount: 3,
  ownerType: "User",
  claimedBy: null,
  viewerClaim: null,
  accountMethod: { available: true, reason: null },
};

describe("the ?repo= parameter", () => {
  it("is normalized like the server stores it, or refused", () => {
    expect(normalizeClaimRepo("Acme/Skills")).toBe("acme/skills");
    expect(normalizeClaimRepo(" acme/skills ")).toBe("acme/skills");
    expect(normalizeClaimRepo("acme/../x")).toBeNull();
    expect(normalizeClaimRepo("https://github.com/acme/skills")).toBeNull();
    expect(normalizeClaimRepo(null)).toBeNull();
    expect(normalizeClaimRepo("")).toBeNull();
    expect(claimPageSearch("acme/skills")).toBe("?repo=acme%2Fskills");
    expect(claimPageSearch(null)).toBe("");
  });
});

describe("claimRepositoryPlan", () => {
  it("offers nothing on a repository already claimed", () => {
    expect(claimRepositoryPlan({ ...personal, claimedBy: "someone" })).toEqual({
      kind: "claimedBySomeone",
    });
    expect(claimRepositoryPlan({ ...personal, claimedBy: "you" })).toEqual({
      kind: "claimedByYou",
    });
  });

  it("offers a personal repository's owner the account method, with its reason", () => {
    expect(claimRepositoryPlan(personal)).toEqual({
      kind: "open",
      account: { available: true, reason: null },
    });
    expect(
      claimRepositoryPlan({
        ...personal,
        accountMethod: { available: false, reason: "not_owner" },
      }),
    ).toEqual({
      kind: "open",
      account: { available: false, reason: "not_owner" },
    });
    // Not looked up yet: GitHub decides when they try.
    expect(claimRepositoryPlan({ ...personal, ownerType: null }).kind).toBe(
      "open",
    );
  });

  it("sends an organization's repository to an admin, never to self-service", () => {
    expect(
      claimRepositoryPlan({
        ...personal,
        ownerType: "Organization",
        accountMethod: { available: false, reason: "organization" },
      }),
    ).toEqual({ kind: "organization" });
    // Known to be an organization's even while the viewer is not linked.
    expect(
      claimRepositoryPlan({
        ...personal,
        ownerType: "Organization",
        accountMethod: { available: false, reason: "not_linked" },
      }),
    ).toEqual({ kind: "organization" });
  });

  it("asks support by email with the repository in the subject", () => {
    const url = new URL(claimRequestMailto("acme/skills"));
    expect(url.protocol).toBe("mailto:");
    expect(url.pathname).toBe("support@sourceweft.com");
    expect(url.searchParams.get("subject")).toBe("Claim acme/skills");
  });
});

describe("sortClaims", () => {
  it("puts standing claims first, newest first", () => {
    const claims: SkillRepoClaim[] = [
      { ...verified, id: "old-revoked", status: "revoked", createdAt: "2026-01-01T00:00:00.000Z" },
      { ...verified, id: "new-verified", createdAt: "2026-09-20T00:00:00.000Z" },
      { ...verified, id: "old-verified", method: "admin_grant", createdAt: "2026-02-01T00:00:00.000Z" },
      { ...verified, id: "newer-revoked", status: "revoked", createdAt: "2026-09-21T00:00:00.000Z" },
    ];
    expect(sortClaims(claims).map((claim) => claim.id)).toEqual([
      "new-verified",
      "old-verified",
      "newer-revoked",
      "old-revoked",
    ]);
  });
});
