import { describe, expect, it } from "vitest";
import type {
  SkillClaimRepository,
  SkillRepoClaim,
} from "@sourceweft/contracts";

import {
  claimPageSearch,
  claimRepositoryPlan,
  normalizeClaimRepo,
  sortClaims,
} from "./claim-view";

const pending: SkillRepoClaim = {
  id: "claim-2",
  repo: "acme/skills",
  method: "verification_file",
  status: "pending",
  createdAt: "2026-09-20T00:00:00.000Z",
  verifiedAt: null,
  expiresAt: "2026-09-27T00:00:00.000Z",
};
const repository: SkillClaimRepository = {
  repo: "acme/skills",
  skillCount: 3,
  ownerType: "Organization",
  claimedBy: null,
  viewerClaim: null,
  accountMethod: { available: false, reason: "organization" },
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
    expect(
      claimRepositoryPlan({ ...repository, claimedBy: "someone" }, null),
    ).toEqual({ kind: "claimedBySomeone" });
    expect(claimRepositoryPlan({ ...repository, claimedBy: "you" }, null)).toEqual(
      { kind: "claimedByYou" },
    );
  });

  it("keeps the account method's reason and starts the file method from nothing", () => {
    expect(claimRepositoryPlan(repository, null)).toEqual({
      kind: "open",
      account: { available: false, reason: "organization" },
      file: { state: "none" },
    });
  });

  it("shows the token only from the response that issued it for this claim", () => {
    const withPending = { ...repository, viewerClaim: pending };
    const issued = {
      claim: pending,
      verification: { token: "tok", path: ".sourceweft/claim", branch: "main" },
    };
    expect(claimRepositoryPlan(withPending, issued).kind).toBe("open");
    expect(claimRepositoryPlan(withPending, issued)).toMatchObject({
      file: {
        state: "token",
        claimId: "claim-2",
        token: "tok",
        path: ".sourceweft/claim",
        branch: "main",
      },
    });
    // After a reload the token is gone; the claim can still be verified.
    expect(claimRepositoryPlan(withPending, null)).toMatchObject({
      file: {
        state: "pending",
        claimId: "claim-2",
        expiresAt: "2026-09-27T00:00:00.000Z",
      },
    });
    // A token for an older claim that a newer one replaced is never shown.
    expect(
      claimRepositoryPlan(withPending, {
        ...issued,
        claim: { ...pending, id: "claim-1" },
      }),
    ).toMatchObject({ file: { state: "pending" } });
  });
});

describe("sortClaims", () => {
  it("puts live claims first, newest first", () => {
    const claims: SkillRepoClaim[] = [
      { ...pending, id: "old-expired", status: "expired", createdAt: "2026-01-01T00:00:00.000Z" },
      { ...pending, id: "new-pending", createdAt: "2026-09-20T00:00:00.000Z" },
      {
        ...pending,
        id: "verified",
        status: "verified",
        createdAt: "2026-02-01T00:00:00.000Z",
      },
      { ...pending, id: "newer-revoked", status: "revoked", createdAt: "2026-09-21T00:00:00.000Z" },
    ];
    expect(sortClaims(claims).map((claim) => claim.id)).toEqual([
      "verified",
      "new-pending",
      "newer-revoked",
      "old-expired",
    ]);
  });
});
