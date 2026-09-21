import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, count, desc, eq, notExists, sql } from "drizzle-orm";
import {
  parseSkillClaimRepo,
  SKILL_CLAIM_FILE_PATH,
  SKILL_CLAIM_PENDING_TTL_DAYS,
  type RemoveSkillRepoFromMarketResponse,
  type RevokeSkillClaimResponse,
  type SkillClaimAccountMethod,
  type SkillClaimMethod,
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
import { setOwnerSkillListing } from "./listing";

/**
 * Authors claiming the GitHub repository their community skills come from
 * (skill-marketplace-plan §13.3).
 *
 * A claim is only ever started by the author, and ownership only changes once
 * GitHub itself vouches for them: either their linked GitHub account is the
 * repository's (personal) owner, or they commit a one-time token to the
 * default branch. Nothing here asks for an OAuth scope or keeps a token — the
 * account method compares ids from public API answers, the file method stores
 * only the token's hash.
 *
 * A verified claim moves every active community skill of the repository to
 * the author: listing control, the "claimed" mark, and removal. Workspaces
 * that installed those skills keep them — entitlements and installs are not
 * touched.
 */

export type ClaimRepo = { owner: string; name: string };

const PENDING_TTL_MS = SKILL_CLAIM_PENDING_TTL_DAYS * 24 * 60 * 60 * 1000;

/** The one index that keeps a repository to a single author. */
const VERIFIED_CLAIM_CONSTRAINT = "skill_repo_claims_verified_uq";

function repoLabel(repo: ClaimRepo) {
  return `${repo.owner}/${repo.name}`;
}

// --- Token ---------------------------------------------------------------

/** sha256 hex of a token, as `skill_repo_claims.token_hash` stores it. */
export function hashClaimToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * A fresh token and its hash. 32 random bytes — guessing one is not a way
 * into someone's repository. The prefix makes a stray file recognizable.
 */
export function createClaimToken(): { token: string; tokenHash: string } {
  const token = `sourceweft-claim-${randomBytes(32).toString("base64url")}`;
  return { token, tokenHash: hashClaimToken(token) };
}

/**
 * Whether a verification file holds the token behind `tokenHash`. Surrounding
 * whitespace is forgiven — editors add a trailing newline — anything else is
 * not. Hashes are compared in constant time.
 */
export function claimFileMatches(
  fileContent: string,
  tokenHash: string,
): boolean {
  const candidate = Buffer.from(hashClaimToken(fileContent.trim()), "hex");
  const expected = Buffer.from(tokenHash, "hex");
  return (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
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
 * GitHub. An organization's repository can never be claimed by the account
 * method: being a member is not the same as being its author, and reading
 * membership would need a scope we do not ask for.
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
      "This repository belongs to an organization; use the verification file",
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
    "Link your GitHub account in settings, or use the verification file",
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

/** The file method's verdict on what the default branch holds. */
export function assertClaimFile(input: {
  fileContent: string | null;
  tokenHash: string | null;
}) {
  if (input.fileContent === null) {
    throw new ContentError(
      422,
      "SKILL_CLAIM_FILE_MISSING",
      `${SKILL_CLAIM_FILE_PATH} was not found on the repository's default branch`,
    );
  }
  if (!input.tokenHash || !claimFileMatches(input.fileContent, input.tokenHash)) {
    throw new ContentError(
      422,
      "SKILL_CLAIM_FILE_MISMATCH",
      `${SKILL_CLAIM_FILE_PATH} does not contain this claim's token`,
    );
  }
}

function claimExpired(createdAt: Date, now: Date) {
  return now.getTime() - createdAt.getTime() > PENDING_TTL_MS;
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

/** Largest verification file read; the token is under a hundred bytes. */
const CLAIM_FILE_MAX_BYTES = 4096;

/**
 * The verification file on `branch`, decoded; null when it is not there (or
 * is not a file). Read by branch name from the repository itself, so a commit
 * that only exists in a fork cannot supply it.
 */
export async function fetchClaimFile(
  repo: ClaimRepo,
  branch: string,
): Promise<string | null> {
  const path = SKILL_CLAIM_FILE_PATH.split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const data = (await githubJson(
    `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/contents/${path}?ref=${encodeURIComponent(branch)}`,
  )) as {
    type?: unknown;
    encoding?: unknown;
    content?: unknown;
    size?: unknown;
  } | null;
  if (!data || data.type !== "file") return null;
  if (typeof data.size === "number" && data.size > CLAIM_FILE_MAX_BYTES) {
    // Present, but cannot be a token file.
    return "";
  }
  if (data.encoding !== "base64" || typeof data.content !== "string") {
    return null;
  }
  return Buffer.from(data.content, "base64").toString("utf8");
}

export type ClaimGitHub = {
  fetchRepoFacts: (repo: ClaimRepo) => Promise<GitHubRepoFacts | null>;
  fetchClaimFile: (repo: ClaimRepo, branch: string) => Promise<string | null>;
};

const defaultGitHub: ClaimGitHub = {
  fetchRepoFacts: fetchGitHubRepoFacts,
  fetchClaimFile,
};

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

function toClaim(row: ClaimRow, now = new Date()): SkillRepoClaim {
  const pending = row.status === "pending";
  return {
    id: row.id,
    repo: `${row.repoOwner}/${row.repoName}`,
    method: row.method,
    status: pending && claimExpired(row.createdAt, now) ? "expired" : row.status,
    createdAt: row.createdAt.toISOString(),
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    expiresAt: pending
      ? new Date(row.createdAt.getTime() + PENDING_TTL_MS).toISOString()
      : null,
  };
}

async function findVerifiedClaim(repo: ClaimRepo) {
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
  return row ?? null;
}

async function listUserClaims(userId: string): Promise<ClaimRow[]> {
  return db
    .select()
    .from(skillRepoClaims)
    .where(eq(skillRepoClaims.userId, userId))
    .orderBy(desc(skillRepoClaims.createdAt))
    .limit(100);
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
  userClaims: ClaimRow[];
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
  const now = new Date();
  const viewerClaim = input.userClaims.find(
    (row) =>
      row.repoOwner === input.repo.owner &&
      row.repoName === input.repo.name &&
      (row.status === "verified" ||
        (row.status === "pending" && !claimExpired(row.createdAt, now))),
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
    viewerClaim: viewerClaim ? toClaim(viewerClaim, now) : null,
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
  const now = new Date();
  return {
    githubLinked: linkedGithubId !== null,
    claims: userClaims.map((row) => toClaim(row, now)),
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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The claim becomes verified and the repository's skills become the author's,
 * in one transaction. The partial unique index is the arbiter between two
 * authors racing: the second one's update fails and nothing of theirs lands.
 */
async function applyVerifiedClaim(
  tx: Tx,
  input: { claimId: string; userId: string; repo: ClaimRepo; now: Date },
) {
  await tx
    .update(skillRepoClaims)
    .set({ status: "verified", verifiedAt: input.now })
    .where(eq(skillRepoClaims.id, input.claimId));
  // The previous importer loses listing control; what they (and everyone
  // else) installed stays installed.
  await tx
    .update(skillDefinitions)
    .set({
      ownerUserId: input.userId,
      claimedAt: input.now,
      updatedAt: input.now,
    })
    .where(activeRegistrySkillsOf(input.repo));
}

async function insertClaim(input: {
  repo: ClaimRepo;
  userId: string;
  method: SkillClaimMethod;
  tokenHash: string | null;
  verify: boolean;
}): Promise<ClaimRow> {
  const now = new Date();
  try {
    return await db.transaction(async (tx) => {
      // Starting again replaces a pending claim rather than piling them up;
      // only the newest token is worth committing.
      await tx
        .delete(skillRepoClaims)
        .where(
          and(
            eq(skillRepoClaims.userId, input.userId),
            eq(skillRepoClaims.repoOwner, input.repo.owner),
            eq(skillRepoClaims.repoName, input.repo.name),
            eq(skillRepoClaims.status, "pending"),
          ),
        );
      const id = randomUUID();
      const [row] = await tx
        .insert(skillRepoClaims)
        .values({
          id,
          repoOwner: input.repo.owner,
          repoName: input.repo.name,
          userId: input.userId,
          method: input.method,
          tokenHash: input.tokenHash,
          status: "pending",
          createdAt: now,
        })
        .returning();
      if (!input.verify) return row!;
      await applyVerifiedClaim(tx, {
        claimId: id,
        userId: input.userId,
        repo: input.repo,
        now,
      });
      return { ...row!, status: "verified" as const, verifiedAt: now };
    });
  } catch (error) {
    if (isVerifiedClaimConflict(error)) throw alreadyClaimed();
    throw error;
  }
}

/**
 * Starts a claim. The account method is decided on the spot (GitHub answers,
 * the claim is verified or refused, nothing pending is left behind); the file
 * method returns a token — once — for the author to commit.
 *
 * A repository the user already holds answers with that claim; one someone
 * else holds is refused before anything is written.
 */
export async function startSkillClaim(
  input: { userId: string; repo: string; method: SkillClaimMethod },
  github: ClaimGitHub = defaultGitHub,
): Promise<StartSkillClaimResponse> {
  const repo = parseSkillClaimRepo(input.repo);
  if (!repo) {
    throw new ContentError(
      400,
      "VALIDATION_ERROR",
      "Expected a GitHub repository as owner/repo",
    );
  }
  await requireRepoWithSkills(repo);
  const verified = await findVerifiedClaim(repo);
  if (verified) {
    if (verified.userId !== input.userId) throw alreadyClaimed();
    return { claim: toClaim(verified), verification: null };
  }

  if (input.method === "github_account") {
    const linkedGithubId = await getLinkedGithubAccountId(input.userId);
    // Refused before asking GitHub: there is nothing to compare against.
    if (!linkedGithubId) throw githubNotLinked();
    const facts = await requireRepoFacts(repo, github);
    await rememberRepoFacts(repo, facts);
    assertAccountOwnsRepo({ repo, linkedGithubId, facts });
    const row = await insertClaim({
      repo,
      userId: input.userId,
      method: "github_account",
      tokenHash: null,
      verify: true,
    });
    return { claim: toClaim(row), verification: null };
  }

  // The branch is only a hint for the author; verify reads GitHub again. A
  // GitHub outage must not stop someone from getting their token.
  let branch: string | null = null;
  try {
    const facts = await github.fetchRepoFacts(repo);
    if (facts) {
      assertSameRepo(repo, facts);
      await rememberRepoFacts(repo, facts);
      branch = facts.defaultBranch;
    }
  } catch (error) {
    if (
      error instanceof ContentError &&
      error.code === "SKILL_CLAIM_REPO_MOVED"
    ) {
      throw error;
    }
  }
  const { token, tokenHash } = createClaimToken();
  const row = await insertClaim({
    repo,
    userId: input.userId,
    method: "verification_file",
    tokenHash,
    verify: false,
  });
  return {
    claim: toClaim(row),
    verification: { token, path: SKILL_CLAIM_FILE_PATH, branch },
  };
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
 * Checks a pending verification-file claim against the default branch as it
 * is now, and applies it when the token is there.
 */
export async function verifySkillClaim(
  input: { userId: string; claimId: string },
  github: ClaimGitHub = defaultGitHub,
): Promise<SkillRepoClaim> {
  const claim = await requireUserClaim(input);
  if (claim.status === "verified") return toClaim(claim);
  if (claim.status !== "pending" || claim.method !== "verification_file") {
    throw new ContentError(
      409,
      "SKILL_CLAIM_NOT_PENDING",
      "This claim is not waiting for verification; start a new one",
    );
  }
  if (claimExpired(claim.createdAt, new Date())) {
    throw new ContentError(
      410,
      "SKILL_CLAIM_EXPIRED",
      `This claim expired after ${SKILL_CLAIM_PENDING_TTL_DAYS} days; start a new one for a fresh token`,
    );
  }
  const repo = { owner: claim.repoOwner, name: claim.repoName };
  if ((await findVerifiedClaim(repo)) !== null) throw alreadyClaimed();

  // GitHub is read outside the transaction: a slow API must not hold locks.
  const facts = await requireRepoFacts(repo, github);
  assertSameRepo(repo, facts);
  await rememberRepoFacts(repo, facts);
  assertClaimFile({
    fileContent: await github.fetchClaimFile(repo, facts.defaultBranch),
    tokenHash: claim.tokenHash,
  });

  const now = new Date();
  try {
    return await db.transaction(async (tx) => {
      // Re-read under lock: the claim may have been replaced by a newer start
      // (a different token) or verified by a parallel request meanwhile.
      const [current] = await tx
        .select()
        .from(skillRepoClaims)
        .where(eq(skillRepoClaims.id, claim.id))
        .limit(1)
        .for("update");
      if (!current) {
        throw new ContentError(404, "SKILL_CLAIM_NOT_FOUND", "Claim not found");
      }
      if (current.status === "verified") return toClaim(current);
      if (current.status !== "pending") {
        throw new ContentError(
          409,
          "SKILL_CLAIM_NOT_PENDING",
          "This claim is not waiting for verification; start a new one",
        );
      }
      await applyVerifiedClaim(tx, {
        claimId: claim.id,
        userId: input.userId,
        repo,
        now,
      });
      return toClaim({ ...current, status: "verified", verifiedAt: now });
    });
  } catch (error) {
    if (isVerifiedClaimConflict(error)) throw alreadyClaimed();
    throw error;
  }
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
    });
    if (result) removed += 1;
  }
  // Recorded on the claim, not on the skills: the repository as a whole is
  // off SourceWeft, so a skill it ships later is refused at import too
  // (`isSkillRepositoryRemoved`). An admin revoking the claim lifts it.
  await db
    .update(skillRepoClaims)
    .set({ removedAt: new Date(), removedBy: input.userId })
    .where(eq(skillRepoClaims.id, claim.id));
  return { repo: repoLabel(repo), skillCount: removed };
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
    if (claim.status === "verified") {
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
