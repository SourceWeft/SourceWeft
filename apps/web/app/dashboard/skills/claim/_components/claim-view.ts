import { formatDisplayDate } from "@/lib/i18n/format";
import {
  parseSkillClaimRepo,
  type SkillClaimRepository,
  type SkillRepoClaim,
} from "@sourceweft/contracts";

import { SUPPORT_EMAIL } from "../../../../[locale]/skills/_components/skills-constants";

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
  // Owned by an organization: no one claims it themselves; they ask an admin.
  | { kind: "organization" }
  | { kind: "open"; account: SkillClaimRepository["accountMethod"] };

/**
 * What the repository card offers. Only a repository's owner may claim it: a
 * personal repository's owner does it with their linked GitHub account, and
 * an organization's repository is granted by an admin on request.
 */
export function claimRepositoryPlan(
  repository: SkillClaimRepository,
): ClaimRepositoryPlan {
  if (repository.claimedBy === "you") return { kind: "claimedByYou" };
  if (repository.claimedBy === "someone") return { kind: "claimedBySomeone" };
  if (
    repository.ownerType === "Organization" ||
    repository.accountMethod.reason === "organization"
  ) {
    return { kind: "organization" };
  }
  return { kind: "open", account: repository.accountMethod };
}

/**
 * An email to support asking for an organization's repository, with the
 * repository already in the subject so the request is actionable as sent.
 */
export function claimRequestMailto(repo: string) {
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Claim ${repo}`)}`;
}

/** Newest first; a revoked claim sinks below the ones that stand. */
export function sortClaims(claims: readonly SkillRepoClaim[]) {
  const rank = (claim: SkillRepoClaim) => (claim.status === "verified" ? 0 : 1);
  return [...claims].sort(
    (a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt),
  );
}

export function formatClaimDate(iso: string | null, displayLocale: string) {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : formatDisplayDate(date, displayLocale, {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
}
