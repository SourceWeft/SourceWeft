import { z } from "zod";
import { skillMarketStandingSchema } from "./skills";

/**
 * An author claiming the GitHub repository their community skills come from.
 * Only the repository's owner may claim it. A personal repository's owner
 * proves it themselves — their linked GitHub account is the owner — so
 * ownership never changes because of something we inferred. An
 * organization's repository is owned by the organization, which no single
 * person can prove to be; a market admin grants those claims by hand.
 */

export const skillClaimMethodSchema = z.enum([
  "github_account",
  // No longer offered — anyone who could push to a repository could prove it
  // with a file, and pushing is not owning. Kept so a row recorded under it
  // still parses.
  "verification_file",
  // A market admin granted it: how an organization's repository is claimed.
  "admin_grant",
]);
export type SkillClaimMethod = z.infer<typeof skillClaimMethodSchema>;

// GitHub's own rules: a login is alphanumerics and single inner hyphens, at
// most 39 characters; a repository name is alphanumerics, `.`, `_`, `-`.
const githubOwnerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const githubRepoNamePattern = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * `owner/repo`, lowercased the way `skill_definitions.repo_owner/repo_name`
 * store it; null for anything else. Deliberately strict: the value ends up in
 * a GitHub API path, so no `..`, no extra segments, no URL.
 */
export function parseSkillClaimRepo(
  value: string,
): { owner: string; name: string } | null {
  const parts = value.trim().split("/");
  if (parts.length !== 2) return null;
  const [owner = "", name = ""] = parts;
  if (!githubOwnerPattern.test(owner)) return null;
  if (!githubRepoNamePattern.test(name) || name === "." || name === "..") {
    return null;
  }
  return { owner: owner.toLowerCase(), name: name.toLowerCase() };
}

export const skillClaimRepoSchema = z
  .string()
  .trim()
  .max(141)
  .refine((value) => parseSkillClaimRepo(value) !== null, {
    message: "Expected a GitHub repository as owner/repo",
  });

// POST /skills/claims — the account method is the only one an author can
// start; `admin_grant` is the admin route's and nothing else is offered.
export const startSkillClaimRequestSchema = z
  .object({ repo: skillClaimRepoSchema, method: z.literal("github_account") })
  .strict();
export type StartSkillClaimRequest = z.infer<
  typeof startSkillClaimRequestSchema
>;

export const skillRepoClaimSchema = z.object({
  id: z.string(),
  // `owner/repo`, lowercased.
  repo: z.string(),
  method: skillClaimMethodSchema,
  status: z.enum(["verified", "revoked"]),
  createdAt: z.string(),
  verifiedAt: z.string().nullable(),
});
export type SkillRepoClaim = z.infer<typeof skillRepoClaimSchema>;

// Every claim is decided when it is made: verified, or refused with nothing
// written.
export const startSkillClaimResponseSchema = z.object({
  claim: skillRepoClaimSchema,
});
export type StartSkillClaimResponse = z.infer<
  typeof startSkillClaimResponseSchema
>;

export const skillClaimAccountMethodSchema = z.object({
  available: z.boolean(),
  // Why not, when that is known before asking GitHub.
  reason: z.enum(["not_linked", "organization", "not_owner"]).nullable(),
});
export type SkillClaimAccountMethod = z.infer<
  typeof skillClaimAccountMethodSchema
>;

/** One repository as the claim page shows it. */
export const skillClaimRepositorySchema = z.object({
  repo: z.string(),
  // Active community skills indexed from it.
  skillCount: z.number().int().nonnegative(),
  ownerType: z.enum(["User", "Organization"]).nullable(),
  // Whose it is now: never names another person.
  claimedBy: z.enum(["you", "someone"]).nullable(),
  // The viewer's verified claim on it.
  viewerClaim: skillRepoClaimSchema.nullable(),
  accountMethod: skillClaimAccountMethodSchema,
});
export type SkillClaimRepository = z.infer<typeof skillClaimRepositorySchema>;

// GET /skills/claims[?repo=owner/repo | ?skillId=…]
export const skillClaimsOverviewSchema = z.object({
  githubLinked: z.boolean(),
  claims: z.array(skillRepoClaimSchema),
  // Repositories the linked GitHub account owns that have community skills
  // here and nobody has claimed. A hint only: claiming is still the author's
  // explicit act.
  suggestions: z.array(
    z.object({ repo: z.string(), skillCount: z.number().int().nonnegative() }),
  ),
  repository: skillClaimRepositorySchema.nullable(),
});
export type SkillClaimsOverview = z.infer<typeof skillClaimsOverviewSchema>;

// POST /skills/claims/:claimId/remove-from-market
export const removeSkillRepoFromMarketResponseSchema = z.object({
  repo: z.string(),
  // Skills now off the public market and held there by their author.
  skillCount: z.number().int().nonnegative(),
});
export type RemoveSkillRepoFromMarketResponse = z.infer<
  typeof removeSkillRepoFromMarketResponseSchema
>;

/** The verified claim behind a skill, as the market admin sees it. */
export const skillMarketClaimSchema = z.object({
  claimId: z.string(),
  userId: z.string(),
  method: skillClaimMethodSchema,
  verifiedAt: z.string().nullable(),
});
export type SkillMarketClaim = z.infer<typeof skillMarketClaimSchema>;

// GET /skills/registry/admin/skills/:skillId/market carries the claim too.
export const skillMarketStandingWithClaimSchema =
  skillMarketStandingSchema.extend({
    claim: skillMarketClaimSchema.nullable(),
  });
export type SkillMarketStandingWithClaim = z.infer<
  typeof skillMarketStandingWithClaimSchema
>;

// POST /skills/registry/admin/claims — a market admin grants a repository to
// the account behind an email address; how an organization's repository is
// claimed.
export const grantSkillClaimRequestSchema = z
  .object({
    repo: skillClaimRepoSchema,
    email: z.string().trim().toLowerCase().email().max(320),
  })
  .strict();
export type GrantSkillClaimRequest = z.infer<
  typeof grantSkillClaimRequestSchema
>;
export const grantSkillClaimResponseSchema = z.object({
  claim: skillRepoClaimSchema,
  userId: z.string(),
});
export type GrantSkillClaimResponse = z.infer<
  typeof grantSkillClaimResponseSchema
>;

// POST /skills/registry/admin/claims/:claimId/revoke
export const revokeSkillClaimResponseSchema = z.object({
  claimId: z.string(),
  repo: z.string(),
  status: z.literal("revoked"),
});
export type RevokeSkillClaimResponse = z.infer<
  typeof revokeSkillClaimResponseSchema
>;

/** Every error code the claim routes answer with, for the web's messages. */
export const SKILL_CLAIM_ERROR_CODES = [
  "SKILL_CLAIM_REPO_NOT_FOUND",
  "SKILL_REPO_ALREADY_CLAIMED",
  "SKILL_CLAIM_GITHUB_NOT_LINKED",
  "SKILL_CLAIM_ORGANIZATION_REPO",
  "SKILL_CLAIM_ACCOUNT_MISMATCH",
  "SKILL_CLAIM_REPO_MOVED",
  "SKILL_CLAIM_NOT_FOUND",
  "SKILL_CLAIM_NOT_VERIFIED",
  "SKILL_CLAIM_USER_NOT_FOUND",
  "SKILL_CLAIM_GITHUB_UNAVAILABLE",
] as const;
export type SkillClaimErrorCode = (typeof SKILL_CLAIM_ERROR_CODES)[number];
