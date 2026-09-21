import type {
  RemoveSkillRepoFromMarketResponse,
  RevokeSkillClaimResponse,
  SkillClaimMethod,
  SkillClaimsOverview,
  SkillRepoClaim,
  StartSkillClaimResponse,
} from "@sourceweft/contracts";
import { HttpClient } from "@sourceweft/sdk";

import { apiBaseUrl } from "./api-base-url";

/**
 * An author claiming the GitHub repository their community skills come from.
 * The workspace routes act on the signed-in user's own claims; the revoke
 * route is a market admin's (403 for everyone else).
 */
const http = new HttpClient({ baseUrl: apiBaseUrl, credentials: "include" });

function claimsPath(workspaceId: string) {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/skills/claims`;
}

function claimPath(workspaceId: string, claimId: string) {
  return `${claimsPath(workspaceId)}/${encodeURIComponent(claimId)}`;
}

/** The user's claims and suggestions, and optionally one repository's state. */
export function getSkillClaims(
  workspaceId: string,
  about: { repo?: string; skillId?: string } = {},
) {
  const query = new URLSearchParams();
  if (about.repo) query.set("repo", about.repo);
  if (about.skillId) query.set("skillId", about.skillId);
  const search = query.toString();
  return http.get<SkillClaimsOverview>(
    `${claimsPath(workspaceId)}${search ? `?${search}` : ""}`,
  );
}

export function startSkillClaim(
  workspaceId: string,
  input: { repo: string; method: SkillClaimMethod },
) {
  return http.post<StartSkillClaimResponse>(claimsPath(workspaceId), input);
}

export function verifySkillClaim(workspaceId: string, claimId: string) {
  return http.post<{ claim: SkillRepoClaim }>(
    `${claimPath(workspaceId, claimId)}/verify`,
    {},
  );
}

export function removeClaimedRepoFromMarket(
  workspaceId: string,
  claimId: string,
) {
  return http.post<RemoveSkillRepoFromMarketResponse>(
    `${claimPath(workspaceId, claimId)}/remove-from-market`,
    {},
  );
}

export function revokeSkillClaim(claimId: string) {
  return http.post<RevokeSkillClaimResponse>(
    `/v1/skills/registry/admin/claims/${encodeURIComponent(claimId)}/revoke`,
    {},
  );
}
