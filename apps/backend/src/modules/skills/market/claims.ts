import { randomUUID } from "node:crypto";
import { and, count, desc, eq, ne, notExists, sql } from "drizzle-orm";
import {
  parseSkillClaimRepo,
  type GrantSkillClaimResponse,
  type RemoveSkillRepoFromMarketResponse,
  type RestoreSkillRepoToMarketResponse,
  type RevokeSkillClaimResponse,
  type SkillClaimAccountMethod,
  type SkillClaimRepository,
  type SkillClaimsOverview,
  type SkillMarketClaim,
  type SkillRepoClaim,
  type StartSkillClaimResponse,
} from "@sourceweft/contracts";
import {
  db,
  skillDefinitions,
  skillRepoClaims,
  skillRepositories,
} from "@sourceweft/db";
import { ContentError } from "../../content/errors";
import {
  githubDownloadHeaders,
  githubFetch,
} from "../../market/parser/github";
import { recordSkillMarketEvent } from "./events";
import { setOwnerSkillListing } from "./listing";

/**
 * Authors claiming the GitHub repository their community skills come from
 * (skill-marketplace-plan §13.3).
 *
 * Only a repository's owner may claim it. For a personal repository the
 * author proves that themselves: their linked GitHub account is the
 * repository's owner, compared by id from GitHub's public API — no OAuth
 * scope, no token kept. An organization's repository is owned by the
 * organization; being a member, a maintainer or an admin of it is not being
 * its owner, and nothing we could read without a new scope would tell us who
 * speaks for it. So those are never self-service: a market admin grants the
 * claim (`grantSkillClaim`) after hearing from the organization.
 *
 * A verified claim moves every active community skill of the repository to
 * the author: listing control, the "claimed" mark, and removal. Workspaces
 * that installed those skills keep them — entitlements and installs are not
 * touched.
 */

export type ClaimRepo = { owner: string; name: string };

/** The one index that keeps a repository to a single author. */
const VERIFIED_CLAIM_CONSTRAINT = "skill_repo_claims_verified_uq";

function repoLabel(repo: ClaimRepo) {
  return `${repo.owner}/${repo.name}`;
}

// --- Rules ---------------------------------------------------------------

export type GitHubRepoFacts = {
  /** `owner/repo` as GitHub names it now, lowercased. */
  fullName: string;
  ownerGithubId: string;
  ownerType: "User" | "Organization";
  defaultBranch: string;
};

/**
 * Whether the account method can work, from what is known without asking
 * GitHub. An organization's repository can never be claimed by it: its owner
 * is the organization, not any one member (see above).
 */
export function accountMethodAvailability(input: {
  linkedGithubId: string | null;
  ownerType: "User" | "Organization" | null;
  ownerGithubId: string | null;
}): SkillClaimAccountMethod {
  if (!input.linkedGithubId) return { available: false, reason: "not_linked" };
  if (input.ownerType === "Organization") {
    return { available: false, reason: "organization" };
  }
  if (input.ownerGithubId && input.ownerGithubId !== input.linkedGithubId) {
    return { available: false, reason: "not_owner" };
  }
  return { available: true, reason: null };
}

/**
 * The account method's verdict on GitHub's live answer. Throws the error the
 * author sees; returns when the linked account owns the repository.
 */
export function assertAccountOwnsRepo(input: {
  repo: ClaimRepo;
  linkedGithubId: string | null;
  facts: GitHubRepoFacts;
}) {
  assertSameRepo(input.repo, input.facts);
  if (!input.linkedGithubId) throw githubNotLinked();
  if (input.facts.ownerType !== "User") {
    throw new ContentError(
      409,
      "SKILL_CLAIM_ORGANIZATION_REPO",
      "This repository belongs to an organization, so only its owner may claim it and a SourceWeft admin grants that claim; ask support@sourceweft.com",
    );
  }
  if (input.facts.ownerGithubId !== input.linkedGithubId) {
    throw new ContentError(
      403,
      "SKILL_CLAIM_ACCOUNT_MISMATCH",
      "Your linked GitHub account does not own this repository",
    );
  }
}

function githubNotLinked(): ContentError {
  return new ContentError(
    409,
    "SKILL_CLAIM_GITHUB_NOT_LINKED",
    "Link the GitHub account that owns this repository in settings first",
  );
}

/**
 * GitHub follows a renamed or transferred repository to its new name. The
 * skills were indexed under the old one, so an answer about another
 * repository proves nothing about them.
 */
function assertSameRepo(repo: ClaimRepo, facts: GitHubRepoFacts) {
  if (facts.fullName !== repoLabel(repo)) {
    throw new ContentError(
      409,
      "SKILL_CLAIM_REPO_MOVED",
      `This repository is now ${facts.fullName} on GitHub; its skills here were indexed under the old name`,
    );
  }
}

// --- GitHub --------------------------------------------------------------

function githubApiHeaders() {
  return {
    ...githubDownloadHeaders(),
    Accept: "application/vnd.github+json",
  };
}

function githubUnavailable(): ContentError {
  return new ContentError(
    503,
    "SKILL_CLAIM_GITHUB_UNAVAILABLE",
    "GitHub could not be reached to verify this claim; try again shortly",
  );
}

async function githubJson(url: string): Promise<unknown | null> {
  let response: Response;
  try {
    response = await githubFetch(url, githubApiHeaders());
  } catch {
    throw githubUnavailable();
  }
  if (response.status === 404) return null;
  if (!response.ok) throw githubUnavailable();
  try {
    return await response.json();
  } catch {
    throw githubUnavailable();
  }
}

/**
 * Who owns a repository, from GitHub's public API. null when GitHub has no
 * such (public) repository; throws when GitHub could not answer, so a claim is
 * never decided on a guess.
 */
export async function fetchGitHubRepoFacts(
  repo: ClaimRepo,
): Promise<GitHubRepoFacts | null> {
  const data = (await githubJson(
    `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
  )) as {
    full_name?: unknown;
    default_branch?: unknown;
    owner?: { id?: unknown; type?: unknown };
  } | null;
  if (!data) return null;
  const ownerId = data.owner?.id;
  const ownerType = data.owner?.type;
  if (
    (typeof ownerId !== "number" && typeof ownerId !== "string") ||
    (ownerType !== "User" && ownerType !== "Organization") ||
    typeof data.full_name !== "string"
  ) {
    throw githubUnavailable();
  }
  return {
    fullName: data.full_name.toLowerCase(),
    ownerGithubId: String(ownerId),
    ownerType,
    defaultBranch:
      typeof data.default_branch === "string" && data.default_branch
        ? data.default_branch
        : "main",
  };
}

export type ClaimGitHub = {
  fetchRepoFacts: (repo: ClaimRepo) => Promise<GitHubRepoFacts | null>;
};

const defaultGitHub: ClaimGitHub = { fetchRepoFacts: fetchGitHubRepoFacts };

/** GitHub's answer, or the 404 an author sees for a repository it lacks. */
async function requireRepoFacts(repo: ClaimRepo, github: ClaimGitHub) {
  const facts = await github.fetchRepoFacts(repo);
  if (!facts) {
    throw new ContentError(
      404,
      "SKILL_CLAIM_REPO_NOT_FOUND",
      "GitHub has no public repository by that name",
    );
  }
  return facts;
}

/**
 * Keeps what GitHub just said about the owner, for suggestions. Only fills a
 * row nobody has written: the scheduler owns refreshing it (with ETags).
 */
async function rememberRepoFacts(repo: ClaimRepo, facts: GitHubRepoFacts) {
  await db
    .insert(skillRepositories)
    .values({
      repoOwner: repo.owner,
      repoName: repo.name,
      ownerGithubId: facts.ownerGithubId,
      ownerType: facts.ownerType,
      defaultBranch: facts.defaultBranch,
    })
    .onConflictDoNothing();
}

// --- Reads ---------------------------------------------------------------

/**
 * The GitHub account id the user linked through sign-in (better-auth's
 * `account` table, whose `accountId` is GitHub's numeric user id).
 */
export async function getLinkedGithubAccountId(
  userId: string,
): Promise<string | null> {
  const result = await db.execute<{ accountId: string }>(sql`
    select "accountId" from "account"
    where "userId" = ${userId} and "providerId" = 'github'
    order by "createdAt" asc
    limit 1
  `);
  return result.rows?.[0]?.accountId ?? null;
}

function activeRegistrySkillsOf(repo: ClaimRepo) {
  return and(
    eq(skillDefinitions.sourceType, "registry_github"),
    eq(skillDefinitions.status, "active"),
    eq(skillDefinitions.repoOwner, repo.owner),
    eq(skillDefinitions.repoName, repo.name),
  );
}

async function countRepoSkills(repo: ClaimRepo): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(skillDefinitions)
    .where(activeRegistrySkillsOf(repo));
  return row?.total ?? 0;
}

async function requireRepoWithSkills(repo: ClaimRepo): Promise<number> {
  const skillCount = await countRepoSkills(repo);
  if (skillCount === 0) {
    throw new ContentError(
      404,
      "SKILL_CLAIM_REPO_NOT_FOUND",
      "No community skills here come from that repository",
    );
  }
  return skillCount;
}

type ClaimRow = typeof skillRepoClaims.$inferSelect;

/**
 * `pending` rows are left over from the retired verification-file method:
 * never shown, never acted on, so every read leaves them out.
 */
type DecidedClaimRow = ClaimRow & { status: "verified" | "revoked" };

function isDecided(row: ClaimRow): row is DecidedClaimRow {
  return row.status !== "pending";
}

function toClaim(row: DecidedClaimRow): SkillRepoClaim {
  return {
    id: row.id,
    repo: `${row.repoOwner}/${row.repoName}`,
    method: row.method,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    removedAt: row.removedAt?.toISOString() ?? null,
  };
}

async function findVerifiedClaim(
  repo: ClaimRepo,
): Promise<DecidedClaimRow | null> {
  const [row] = await db
    .select()
    .from(skillRepoClaims)
    .where(
      and(
        eq(skillRepoClaims.repoOwner, repo.owner),
        eq(skillRepoClaims.repoName, repo.name),
        eq(skillRepoClaims.status, "verified"),
      ),
    )
    .limit(1);
  return row && isDecided(row) ? row : null;
}

async function listUserClaims(userId: string): Promise<DecidedClaimRow[]> {
  const rows = await db
    .select()
    .from(skillRepoClaims)
    .where(
      and(
        eq(skillRepoClaims.userId, userId),
        ne(skillRepoClaims.status, "pending"),
      ),
    )
    .orderBy(desc(skillRepoClaims.createdAt))
    .limit(100);
  return rows.filter(isDecided);
}

/**
 * Unclaimed repositories with community skills here whose owner is the
 * user's linked GitHub account. Ownership comes from `skill_repositories`,
 * which the scheduler fills; a repository it has not looked at yet is simply
 * not suggested.
 */
async function listClaimSuggestions(linkedGithubId: string) {
  const rows = await db
    .select({
      repoOwner: skillRepositories.repoOwner,
      repoName: skillRepositories.repoName,
      skillCount: count(skillDefinitions.id),
    })
    .from(skillRepositories)
    .innerJoin(
      skillDefinitions,
      and(
        eq(skillDefinitions.repoOwner, skillRepositories.repoOwner),
        eq(skillDefinitions.repoName, skillRepositories.repoName),
        eq(skillDefinitions.sourceType, "registry_github"),
        eq(skillDefinitions.status, "active"),
      ),
    )
    .where(
      and(
        eq(skillRepositories.ownerGithubId, linkedGithubId),
        eq(skillRepositories.ownerType, "User"),
        notExists(
          db
            .select({ id: skillRepoClaims.id })
            .from(skillRepoClaims)
            .where(
              and(
                eq(skillRepoClaims.repoOwner, skillRepositories.repoOwner),
                eq(skillRepoClaims.repoName, skillRepositories.repoName),
                eq(skillRepoClaims.status, "verified"),
              ),
            ),
        ),
      ),
    )
    .groupBy(skillRepositories.repoOwner, skillRepositories.repoName)
    .orderBy(
      desc(count(skillDefinitions.id)),
      skillRepositories.repoOwner,
      skillRepositories.repoName,
    )
    .limit(20);
  return rows.map((row) => ({
    repo: `${row.repoOwner}/${row.repoName}`,
    skillCount: row.skillCount,
  }));
}

async function repoOfSkill(skillId: string): Promise<ClaimRepo | null> {
  const [row] = await db
    .select({
      owner: skillDefinitions.repoOwner,
      name: skillDefinitions.repoName,
    })
    .from(skillDefinitions)
    .where(
      and(
        eq(skillDefinitions.id, skillId),
        eq(skillDefinitions.sourceType, "registry_github"),
      ),
    )
    .limit(1);
  return row?.owner && row.name ? { owner: row.owner, name: row.name } : null;
}

async function describeRepository(input: {
  repo: ClaimRepo;
  userId: string;
  linkedGithubId: string | null;
  userClaims: DecidedClaimRow[];
}): Promise<SkillClaimRepository | null> {
  const skillCount = await countRepoSkills(input.repo);
  if (skillCount === 0) return null;
  const [facts] = await db
    .select({
      ownerGithubId: skillRepositories.ownerGithubId,
      ownerType: skillRepositories.ownerType,
    })
    .from(skillRepositories)
    .where(
      and(
        eq(skillRepositories.repoOwner, input.repo.owner),
        eq(skillRepositories.repoName, input.repo.name),
      ),
    )
    .limit(1);
  const verified = await findVerifiedClaim(input.repo);
  const viewerClaim = input.userClaims.find(
    (row) =>
      row.repoOwner === input.repo.owner &&
      row.repoName === input.repo.name &&
      row.status === "verified",
  );
  return {
    repo: repoLabel(input.repo),
    skillCount,
    ownerType: facts?.ownerType ?? null,
    claimedBy: verified
      ? verified.userId === input.userId
        ? "you"
        : "someone"
      : null,
    viewerClaim: viewerClaim ? toClaim(viewerClaim) : null,
    accountMethod: accountMethodAvailability({
      linkedGithubId: input.linkedGithubId,
      ownerType: facts?.ownerType ?? null,
      ownerGithubId: facts?.ownerGithubId ?? null,
    }),
  };
}

/**
 * The claim page's data: the user's claims, what they could claim, and —
 * when asked about one repository (by name, or by one of its skills) — where
 * that repository stands.
 */
export async function getSkillClaimsOverview(input: {
  userId: string;
  repo?: ClaimRepo | null;
  skillId?: string | null;
}): Promise<SkillClaimsOverview> {
  const linkedGithubId = await getLinkedGithubAccountId(input.userId);
  const userClaims = await listUserClaims(input.userId);
  const repo =
    input.repo ?? (input.skillId ? await repoOfSkill(input.skillId) : null);
  return {
    githubLinked: linkedGithubId !== null,
    claims: userClaims.map(toClaim),
    suggestions: linkedGithubId
      ? await listClaimSuggestions(linkedGithubId)
      : [],
    repository: repo
      ? await describeRepository({
          repo,
          userId: input.userId,
          linkedGithubId,
          userClaims,
        })
      : null,
  };
}

// --- Writes --------------------------------------------------------------

function isVerifiedClaimConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { code?: unknown; constraint?: unknown };
    if (
      record.code === "23505" &&
      (record.constraint === undefined ||
        record.constraint === VERIFIED_CLAIM_CONSTRAINT)
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function alreadyClaimed(): ContentError {
  return new ContentError(
    409,
    "SKILL_REPO_ALREADY_CLAIMED",
    "Another author has already claimed this repository; a market admin can review it",
  );
}

/**
 * Records a verified claim and hands the repository's skills to its author,
 * in one transaction — the one path for every way a claim is made, so a
 * self-service claim and an admin's grant transfer exactly the same things.
 * The partial unique index is the arbiter between two claims racing: the
 * second insert fails and nothing of it lands.
 */
async function recordVerifiedClaim(input: {
  repo: ClaimRepo;
  userId: string;
  method: "github_account" | "admin_grant";
  /** The admin granting it; the claimant themselves otherwise. */
  actorUserId?: string | null;
}): Promise<DecidedClaimRow> {
  const now = new Date();
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(skillRepoClaims)
        .values({
          id: randomUUID(),
          repoOwner: input.repo.owner,
          repoName: input.repo.name,
          userId: input.userId,
          method: input.method,
          status: "verified",
          createdAt: now,
          verifiedAt: now,
        })
        .returning();
      // The previous importer loses listing control; what they (and everyone
      // else) installed stays installed.
      const moved = await tx
        .update(skillDefinitions)
        .set({ ownerUserId: input.userId, claimedAt: now, updatedAt: now })
        .where(activeRegistrySkillsOf(input.repo))
        .returning({ id: skillDefinitions.id });
      const byAdmin = input.method === "admin_grant";
      await recordSkillMarketEvent(
        {
          repo: input.repo,
          actorKind: byAdmin ? "admin" : "owner",
          actorUserId: byAdmin ? (input.actorUserId ?? null) : input.userId,
          action: "claim.granted",
          detail: {
            claimId: row!.id,
            method: input.method,
            userId: input.userId,
            skillCount: moved.length,
          },
        },
        tx,
      );
      return { ...row!, status: "verified" as const };
    });
  } catch (error) {
    if (isVerifiedClaimConflict(error)) throw alreadyClaimed();
    throw error;
  }
}

function requireClaimRepo(value: string): ClaimRepo {
  const repo = parseSkillClaimRepo(value);
  if (!repo) {
    throw new ContentError(
      400,
      "VALIDATION_ERROR",
      "Expected a GitHub repository as owner/repo",
    );
  }
  return repo;
}

/**
 * An author claims a personal repository they own. Decided on the spot:
 * GitHub answers, and the claim is verified or refused with nothing written.
 * An organization's repository is refused with the way to ask an admin.
 *
 * A repository the user already holds answers with that claim; one someone
 * else holds is refused before GitHub is asked.
 */
export async function startSkillClaim(
  input: { userId: string; repo: string; method: "github_account" },
  github: ClaimGitHub = defaultGitHub,
): Promise<StartSkillClaimResponse> {
  const repo = requireClaimRepo(input.repo);
  await requireRepoWithSkills(repo);
  const verified = await findVerifiedClaim(repo);
  if (verified) {
    if (verified.userId !== input.userId) throw alreadyClaimed();
    return { claim: toClaim(verified) };
  }

  const linkedGithubId = await getLinkedGithubAccountId(input.userId);
  // Refused before asking GitHub: there is nothing to compare against.
  if (!linkedGithubId) throw githubNotLinked();
  const facts = await requireRepoFacts(repo, github);
  await rememberRepoFacts(repo, facts);
  assertAccountOwnsRepo({ repo, linkedGithubId, facts });
  const row = await recordVerifiedClaim({
    repo,
    userId: input.userId,
    method: "github_account",
  });
  return { claim: toClaim(row) };
}

/** The auth user behind an email address; null when there is none. */
async function findUserIdByEmail(email: string): Promise<string | null> {
  const result = await db.execute<{ id: string }>(sql`
    select id from "user"
    where lower(email) = lower(${email.trim()})
    limit 1
  `);
  return result.rows?.[0]?.id ?? null;
}

/**
 * A market admin grants a repository to the account behind `email` — how an
 * organization's repository is claimed, once its owner has asked. Nothing is
 * asked of GitHub: the admin is the one vouching. Refused when the repository
 * is already claimed; an admin revokes that claim first.
 */
export async function grantSkillClaim(input: {
  repo: string;
  email: string;
  actorUserId?: string;
}): Promise<GrantSkillClaimResponse> {
  const repo = requireClaimRepo(input.repo);
  await requireRepoWithSkills(repo);
  if (await findVerifiedClaim(repo)) throw alreadyClaimed();
  const userId = await findUserIdByEmail(input.email);
  if (!userId) {
    throw new ContentError(
      404,
      "SKILL_CLAIM_USER_NOT_FOUND",
      "No SourceWeft account uses that email address",
    );
  }
  const row = await recordVerifiedClaim({
    repo,
    userId,
    method: "admin_grant",
    actorUserId: input.actorUserId ?? null,
  });
  return { claim: toClaim(row), userId };
}

async function requireUserClaim(input: { userId: string; claimId: string }) {
  const [row] = await db
    .select()
    .from(skillRepoClaims)
    .where(
      and(
        eq(skillRepoClaims.id, input.claimId),
        eq(skillRepoClaims.userId, input.userId),
      ),
    )
    .limit(1);
  // Someone else's claim is as absent as one that does not exist.
  if (!row) {
    throw new ContentError(404, "SKILL_CLAIM_NOT_FOUND", "Claim not found");
  }
  return row;
}

/**
 * "Remove from SourceWeft": every skill of the claimed repository off the
 * public market, held there by its author so the auto-listing pass leaves it
 * alone. Workspaces that installed a skill keep it — the hold and `restricted`
 * visibility still honor their entitlement.
 *
 * Not archiving: an archived definition stops resolving for the workspaces
 * that installed it (`listEnabledWorkspaceSkillRecords` and the install
 * reads all require `status = 'active'`), which would break the promise that
 * existing installs keep working.
 */
export async function removeClaimedRepoFromMarket(input: {
  userId: string;
  claimId: string;
}): Promise<RemoveSkillRepoFromMarketResponse> {
  const claim = await requireUserClaim(input);
  if (claim.status !== "verified") {
    throw new ContentError(
      409,
      "SKILL_CLAIM_NOT_VERIFIED",
      "Only a verified claim can remove the repository's skills",
    );
  }
  const repo = { owner: claim.repoOwner, name: claim.repoName };
  const skills = await db
    .select({ id: skillDefinitions.id })
    .from(skillDefinitions)
    .where(
      and(
        activeRegistrySkillsOf(repo),
        eq(skillDefinitions.ownerUserId, input.userId),
      ),
    );
  // One skill at a time through the owner's own switch, so the admin-hold
  // precedence and the visibility audit stay in one place. Each step is
  // idempotent: a failure part-way is finished by asking again.
  let removed = 0;
  for (const skill of skills) {
    const result = await setOwnerSkillListing({
      skillId: skill.id,
      userId: input.userId,
      listed: false,
      via: "claim.removed",
    });
    if (result) removed += 1;
  }
  // Recorded on the claim, not on the skills: the repository as a whole is
  // off SourceWeft, so a skill it ships later is refused at import too
  // (`isSkillRepositoryRemoved`). An admin revoking the claim, or the author
  // restoring it (`restoreClaimedRepoToMarket`), lifts it.
  await db
    .update(skillRepoClaims)
    .set({ removedAt: new Date(), removedBy: input.userId })
    .where(eq(skillRepoClaims.id, claim.id));
  await recordSkillMarketEvent({
    repo,
    actorKind: "owner",
    actorUserId: input.userId,
    action: "claim.removed",
    detail: { claimId: claim.id, skillCount: removed },
  });
  return { repo: repoLabel(repo), skillCount: removed };
}

/**
 * Lifts the holds an author's own decisions put on a repository's skills —
 * never an admin's. Only the skills the author owns: those are the ones the
 * author's switch could have held.
 */
async function liftOwnerHolds(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: { repo: ClaimRepo; userId: string; now: Date },
): Promise<string[]> {
  const rows = await tx
    .update(skillDefinitions)
    .set({ listingHold: false, listingHoldBy: null, updatedAt: input.now })
    .where(
      and(
        eq(skillDefinitions.sourceType, "registry_github"),
        eq(skillDefinitions.repoOwner, input.repo.owner),
        eq(skillDefinitions.repoName, input.repo.name),
        eq(skillDefinitions.ownerUserId, input.userId),
        eq(skillDefinitions.listingHoldBy, "owner"),
      ),
    )
    .returning({ id: skillDefinitions.id });
  return rows.map((row) => row.id);
}

/**
 * "Restore to SourceWeft": the author undoes `removeClaimedRepoFromMarket`.
 * The repository may be imported again, and the holds the author put on its
 * skills are lifted. Nothing is listed here: the platform's rules decide that
 * on the next upkeep pass (clean scan, confirmed provenance) exactly as for
 * any other skill, and a market admin's hold stays where it is.
 *
 * Lifts every hold the author holds on the repository's skills, including
 * one set by hand before the removal: holds do not record why they were set,
 * and "restore" reads as "put it back as it would be without me".
 * Idempotent: a repository that is not removed is left as it is (0 lifted).
 */
export async function restoreClaimedRepoToMarket(input: {
  userId: string;
  claimId: string;
}): Promise<RestoreSkillRepoToMarketResponse> {
  const claim = await requireUserClaim(input);
  if (claim.status !== "verified") {
    throw new ContentError(
      409,
      "SKILL_CLAIM_NOT_VERIFIED",
      "Only a verified claim can restore the repository's skills",
    );
  }
  const repo = { owner: claim.repoOwner, name: claim.repoName };
  return db.transaction(async (tx) => {
    const now = new Date();
    const [locked] = await tx
      .select({ removedAt: skillRepoClaims.removedAt })
      .from(skillRepoClaims)
      .where(
        and(
          eq(skillRepoClaims.id, claim.id),
          eq(skillRepoClaims.status, "verified"),
        ),
      )
      .limit(1)
      .for("update");
    // Revoked between the read above and this lock.
    if (!locked) {
      throw new ContentError(
        409,
        "SKILL_CLAIM_NOT_VERIFIED",
        "Only a verified claim can restore the repository's skills",
      );
    }
    // Not removed: nothing to undo, and the author's per-skill switches are
    // not this action's to touch.
    if (!locked.removedAt) {
      return { repo: repoLabel(repo), skillCount: 0 };
    }
    await tx
      .update(skillRepoClaims)
      .set({ removedAt: null, removedBy: null })
      .where(eq(skillRepoClaims.id, claim.id));
    const lifted = await liftOwnerHolds(tx, {
      repo,
      userId: input.userId,
      now,
    });
    await recordSkillMarketEvent(
      {
        repo,
        actorKind: "owner",
        actorUserId: input.userId,
        action: "claim.restored",
        detail: { claimId: claim.id, skillCount: lifted.length },
      },
      tx,
    );
    return { repo: repoLabel(repo), skillCount: lifted.length };
  });
}

/**
 * A market admin undoes a claim. The repository's skills lose their claimed
 * mark and go back to whoever first imported each of them (the author of its
 * earliest version) — leaving them with someone the admin just found not to
 * be the author would make the revocation toothless.
 *
 * null for an unknown claim; a claim already revoked answers as it is.
 */
export async function revokeSkillClaim(input: {
  claimId: string;
  actorUserId: string;
}): Promise<RevokeSkillClaimResponse | null> {
  return db.transaction(async (tx) => {
    const [claim] = await tx
      .select()
      .from(skillRepoClaims)
      .where(eq(skillRepoClaims.id, input.claimId))
      .limit(1)
      .for("update");
    if (!claim) return null;
    const repo = { owner: claim.repoOwner, name: claim.repoName };
    const answer = {
      claimId: claim.id,
      repo: repoLabel(repo),
      status: "revoked" as const,
    };
    if (claim.status === "revoked") return answer;
    const now = new Date();
    await tx
      .update(skillRepoClaims)
      .set({ status: "revoked", revokedAt: now, revokedBy: input.actorUserId })
      .where(eq(skillRepoClaims.id, claim.id));
    let liftedHolds: string[] = [];
    if (claim.status === "verified") {
      // Before ownership moves back: the author's holds are the ones on the
      // skills the author owns. Their say ends with the claim, so their
      // "keep it private" does too — the platform's rules decide again. An
      // admin's hold stays.
      liftedHolds = await liftOwnerHolds(tx, {
        repo,
        userId: claim.userId,
        now,
      });
      await tx
        .update(skillDefinitions)
        .set({
          claimedAt: null,
          ownerUserId: sql`coalesce((
            select sv.created_by from skill_versions sv
            where sv.skill_id = ${skillDefinitions.id}
            order by sv.created_at asc, sv.id asc
            limit 1
          ), ${skillDefinitions.ownerUserId})`,
          updatedAt: now,
        })
        .where(
          and(
            eq(skillDefinitions.sourceType, "registry_github"),
            eq(skillDefinitions.repoOwner, repo.owner),
            eq(skillDefinitions.repoName, repo.name),
            eq(skillDefinitions.ownerUserId, claim.userId),
          ),
        );
    }
    await recordSkillMarketEvent(
      {
        repo,
        actorKind: "admin",
        actorUserId: input.actorUserId,
        action: "claim.revoked",
        detail: {
          claimId: claim.id,
          userId: claim.userId,
          from: claim.status,
          wasRemoved: claim.removedAt !== null,
          holdsLifted: liftedHolds.length,
        },
      },
      tx,
    );
    return answer;
  });
}

/** The verified claim behind a skill's repository, for the admin's standing. */
export async function getSkillMarketClaim(
  skillId: string,
): Promise<SkillMarketClaim | null> {
  const repo = await repoOfSkill(skillId);
  if (!repo) return null;
  const claim = await findVerifiedClaim(repo);
  return claim
    ? {
        claimId: claim.id,
        userId: claim.userId,
        method: claim.method,
        verifiedAt: claim.verifiedAt?.toISOString() ?? null,
      }
    : null;
}
