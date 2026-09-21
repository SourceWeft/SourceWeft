import {
  parseSkillClaimRepo,
  type SkillClaimRepository,
  type SkillRepoClaim,
  type StartSkillClaimResponse,
} from "@sourceweft/contracts";

/**
 * `?repo=owner/repo` as the claim page uses it: lowercased like the server
 * stores it, or null when it is not a GitHub repository name at all (so the
 * page never sends a request it knows will be refused).
 */
export function normalizeClaimRepo(value: string | null | undefined) {
  if (!value) return null;
  const parsed = parseSkillClaimRepo(value);
  return parsed ? `${parsed.owner}/${parsed.name}` : null;
}

export function claimPageSearch(repo: string | null) {
  return repo ? `?repo=${encodeURIComponent(repo)}` : "";
}

export type ClaimRepositoryPlan =
  | { kind: "claimedByYou" }
  | { kind: "claimedBySomeone" }
  | {
      kind: "open";
      account: SkillClaimRepository["accountMethod"];
      /**
       * The file method's state: a token just issued (shown once), a pending
       * claim whose token is gone from this page, or nothing started.
       */
      file:
        | { state: "token"; claimId: string; token: string; path: string; branch: string | null }
        | { state: "pending"; claimId: string; expiresAt: string | null }
        | { state: "none" };
    };

/**
 * What the repository card offers. A token only exists in the response that
 * issued it, so it is shown only while that response is for this very
 * repository and its claim is still the one pending.
 */
export function claimRepositoryPlan(
  repository: SkillClaimRepository,
  issued: StartSkillClaimResponse | null,
): ClaimRepositoryPlan {
  if (repository.claimedBy === "you") return { kind: "claimedByYou" };
  if (repository.claimedBy === "someone") return { kind: "claimedBySomeone" };
  const pending =
    repository.viewerClaim?.status === "pending" ? repository.viewerClaim : null;
  let file: Extract<ClaimRepositoryPlan, { kind: "open" }>["file"] = {
    state: "none",
  };
  if (pending) {
    file =
      issued?.verification &&
      issued.claim.id === pending.id &&
      issued.claim.repo === repository.repo
        ? {
            state: "token",
            claimId: pending.id,
            token: issued.verification.token,
            path: issued.verification.path,
            branch: issued.verification.branch,
          }
        : { state: "pending", claimId: pending.id, expiresAt: pending.expiresAt };
  }
  return { kind: "open", account: repository.accountMethod, file };
}

/** Newest first; a claim that went nowhere sinks below the live ones. */
export function sortClaims(claims: readonly SkillRepoClaim[]) {
  const rank = (claim: SkillRepoClaim) =>
    claim.status === "verified" ? 0 : claim.status === "pending" ? 1 : 2;
  return [...claims].sort(
    (a, b) =>
      rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt),
  );
}

export function formatClaimDate(iso: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
}
