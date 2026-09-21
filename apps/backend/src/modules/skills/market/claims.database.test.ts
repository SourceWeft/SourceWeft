import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { sha256 } from "../hash";
import type { ClaimGitHub, GitHubRepoFacts } from "./claims";

// PostgreSQL is real; the object store under `../storage` is a map.
const store = vi.hoisted(() => ({ objects: new Map<string, Buffer>() }));
vi.mock("../../sources/storage", () => ({
  getContentStorageBucketName: () => "bucket",
  sandboxAssetObjectExists: async ({ key }: { key: string }) =>
    store.objects.has(key),
  uploadFileObject: async (input: { key: string; body: Buffer }) => {
    store.objects.set(input.key, input.body);
    return { bucket: "bucket", key: input.key };
  },
}));

/**
 * Author claims against real PostgreSQL: what a verified claim hands the
 * author, that a repository has one author, that removal takes skills off the
 * market without breaking a single install, and that an admin can undo it.
 *
 * GitHub is a fake handed to the claim functions — nothing leaves the machine.
 * Every repository, user and skill here is this file's own.
 */
describe.skipIf(process.env.RUN_SKILL_DB_TESTS !== "1")(
  "skill repository claims (real PostgreSQL)",
  () => {
    let data: typeof import("@sourceweft/db");
    let repo: typeof import("../registry/repository");
    let skills: typeof import("../repository");
    let listing: typeof import("./listing");
    let autoList: typeof import("./auto-list");
    let standing: typeof import("./standing");
    let claims: typeof import("./claims");
    const teamId = `skill-team-${randomUUID()}`;
    const workspaceId = `skill-ws-${randomUUID()}`;
    const skillIds = new Set<string>();
    const repoOwners = new Set<string>();
    const userIds = new Set<string>();

    beforeAll(async () => {
      if (
        !new URL(process.env.DATABASE_URL!).pathname.startsWith(
          "/sourceweft_skillv6_",
        )
      )
        throw new Error("Refusing non-isolated database");
      data = await import("@sourceweft/db");
      repo = await import("../registry/repository");
      skills = await import("../repository");
      listing = await import("./listing");
      autoList = await import("./auto-list");
      standing = await import("./standing");
      claims = await import("./claims");
      await data.db.insert(data.workspaces).values({
        id: workspaceId,
        organizationId: teamId,
        name: "Skill claim tests",
        slug: randomUUID(),
      });
    });
    afterAll(async () => {
      if (!data) return;
      if (skillIds.size > 0)
        await data.db
          .delete(data.skillDefinitions)
          .where(inArray(data.skillDefinitions.id, [...skillIds]));
      if (repoOwners.size > 0) {
        await data.db
          .delete(data.skillRepoClaims)
          .where(inArray(data.skillRepoClaims.repoOwner, [...repoOwners]));
        await data.db
          .delete(data.skillRepositories)
          .where(inArray(data.skillRepositories.repoOwner, [...repoOwners]));
      }
      await data.db
        .delete(data.workspaces)
        .where(eq(data.workspaces.id, workspaceId));
      for (const id of userIds)
        await data.db.execute(sql`delete from "user" where id = ${id}`);
      await data.closeDatabase();
    });

    /** A GitHub repository nobody else in the database uses. */
    function newRepo() {
      const owner = `claim-${randomBytes(6).toString("hex")}`;
      repoOwners.add(owner);
      return { owner, name: "skills", label: `${owner}/skills` };
    }

    /** A signed-up user, optionally with a linked GitHub account. */
    async function user(githubId?: string) {
      const id = `claim-user-${randomUUID()}`;
      userIds.add(id);
      await data.db.execute(sql`
        insert into "user" (id, name, email, "emailVerified")
        values (${id}, 'Claim test', ${`${id}@example.test`}, true)
      `);
      if (githubId)
        await data.db.execute(sql`
          insert into "account" (id, issuer, "accountId", "providerId", "userId", "updatedAt")
          values (${randomUUID()}, 'test:github', ${githubId}, 'github', ${id}, now())
        `);
      return id;
    }

    async function registrySkill(input: {
      owner: string;
      name: string;
      submitterId: string;
      commitSha?: string;
    }) {
      const slug = `gh-claim-${randomUUID()}`;
      const displayName = "Claim fixture";
      const description = "A skill from a repository its author may claim.";
      const contentText = `---\nname: claim-fixture\ndescription: ${description}\n---\nBody\n`;
      const upsert = (
        commitSha = input.commitSha ?? "c".repeat(40),
        committedAt = "2026-01-01T00:00:00.000Z",
      ) =>
        repo.upsertRegistrySkillIndex({
          slug,
          submitterId: input.submitterId,
          displayName,
          description,
          commitSha,
          storagePointer: `github:${input.owner}/${input.name}@${commitSha}#${slug}`,
          versionStatus: "published",
          outcome: "indexed",
          files: [
            {
              path: "SKILL.md",
              bytes: Buffer.from(contentText),
              mimeType: "text/markdown",
            },
          ],
          manifestJson: {
            slug,
            displayName,
            description,
            version: commitSha.slice(0, 12),
            visibility: "restricted",
            categories: [],
            registry: {
              identifier: `gh:${input.owner}/${input.name}/${slug}`,
              sourceUrl: `https://github.com/${input.owner}/${input.name}/tree/${commitSha}/${slug}`,
              repoUrl: `https://github.com/${input.owner}/${input.name}`,
              submittedBy: input.submitterId,
              committedAt,
              // What ingest stamps: listable without asking GitHub.
              provenance: {
                defaultBranch: "main",
                checkedAt: "2026-01-01T00:00:00.000Z",
              },
              capability: "prompt-only",
              scan: { reviewRequired: false, flags: [] },
              fileManifest: [
                {
                  path: "SKILL.md",
                  sha256: sha256(contentText),
                  sizeBytes: Buffer.byteLength(contentText),
                  role: "model-readable",
                },
              ],
            },
          },
        });
      const saved = await upsert();
      skillIds.add(saved.skillId);
      return { ...saved, resubmit: upsert };
    }

    async function definition(skillId: string) {
      const [row] = await data.db
        .select()
        .from(data.skillDefinitions)
        .where(eq(data.skillDefinitions.id, skillId));
      return row!;
    }

    /** GitHub as the claim functions see it. */
    function fakeGitHub(input: {
      facts: Omit<GitHubRepoFacts, "defaultBranch"> & { defaultBranch?: string };
      file?: () => string | null;
    }): ClaimGitHub & { branches: string[] } {
      const branches: string[] = [];
      return {
        branches,
        fetchRepoFacts: async () => ({ defaultBranch: "main", ...input.facts }),
        fetchClaimFile: async (_repo, branch) => {
          branches.push(branch);
          return input.file ? input.file() : null;
        },
      };
    }

    test("a verified account claim hands the author every skill of the repository", async () => {
      const target = newRepo();
      const other = newRepo();
      const importer = await user();
      const author = await user("7001");
      const first = await registrySkill({ ...target, submitterId: importer });
      const second = await registrySkill({ ...target, submitterId: importer });
      const elsewhere = await registrySkill({ ...other, submitterId: importer });
      // Nothing is claimed by importing, or by linking an account.
      expect((await definition(first.skillId)).claimedAt).toBeNull();

      const github = fakeGitHub({
        facts: { fullName: target.label, ownerGithubId: "7001", ownerType: "User" },
      });
      const started = await claims.startSkillClaim(
        { userId: author, repo: target.label, method: "github_account" },
        github,
      );
      expect(started.verification).toBeNull();
      expect(started.claim).toMatchObject({
        repo: target.label,
        method: "github_account",
        status: "verified",
      });

      for (const skill of [first, second]) {
        const row = await definition(skill.skillId);
        expect(row.ownerUserId).toBe(author);
        expect(row.claimedAt).toBeInstanceOf(Date);
      }
      const untouched = await definition(elsewhere.skillId);
      expect(untouched.ownerUserId).toBe(importer);
      expect(untouched.claimedAt).toBeNull();

      // GitHub's answer is kept for suggestions.
      const [remembered] = await data.db
        .select()
        .from(data.skillRepositories)
        .where(eq(data.skillRepositories.repoOwner, target.owner));
      expect(remembered).toMatchObject({ ownerGithubId: "7001", ownerType: "User" });

      // A skill the repository ships later is the author's from the start.
      const later = await registrySkill({ ...target, submitterId: importer });
      expect((await definition(later.skillId)).ownerUserId).toBe(author);
      expect((await definition(later.skillId)).claimedAt).toBeInstanceOf(Date);

      // The listing switch moves with ownership.
      expect(
        await listing.setOwnerSkillListing({
          skillId: first.skillId,
          userId: author,
          listed: false,
        }),
      ).toMatchObject({ heldBy: "owner" });
      expect(
        await listing.setOwnerSkillListing({
          skillId: first.skillId,
          userId: importer,
          listed: true,
        }),
      ).toBeNull();
      expect(
        await listing.getOwnerSkillListing({
          skillId: first.skillId,
          userId: importer,
        }),
      ).toBeNull();

      // The admin's standing names the claim.
      const withClaim = await standing.getSkillMarketStanding(first.skillId);
      expect(withClaim?.claim).toMatchObject({
        claimId: started.claim.id,
        userId: author,
        method: "github_account",
      });
      expect(
        (await standing.getSkillMarketStanding(elsewhere.skillId))?.claim,
      ).toBeNull();

      // Asking again is answered with the claim already held.
      const again = await claims.startSkillClaim(
        { userId: author, repo: target.label, method: "verification_file" },
        github,
      );
      expect(again).toEqual({ claim: started.claim, verification: null });
    });

    test("the account method refuses what GitHub does not vouch for", async () => {
      const target = newRepo();
      const importer = await user();
      await registrySkill({ ...target, submitterId: importer });
      const unlinked = await user();
      const stranger = await user("7102");
      const member = await user("7103");
      const personal = fakeGitHub({
        facts: { fullName: target.label, ownerGithubId: "7101", ownerType: "User" },
      });
      const organization = fakeGitHub({
        facts: {
          fullName: target.label,
          ownerGithubId: "7103",
          ownerType: "Organization",
        },
      });
      const start = (userId: string, github: ClaimGitHub) =>
        claims.startSkillClaim(
          { userId, repo: target.label, method: "github_account" },
          github,
        );
      await expect(start(unlinked, personal)).rejects.toMatchObject({
        code: "SKILL_CLAIM_GITHUB_NOT_LINKED",
      });
      await expect(start(stranger, personal)).rejects.toMatchObject({
        code: "SKILL_CLAIM_ACCOUNT_MISMATCH",
        statusCode: 403,
      });
      await expect(start(member, organization)).rejects.toMatchObject({
        code: "SKILL_CLAIM_ORGANIZATION_REPO",
      });
      // A refused attempt leaves nothing behind.
      const rows = await data.db
        .select()
        .from(data.skillRepoClaims)
        .where(eq(data.skillRepoClaims.repoOwner, target.owner));
      expect(rows).toEqual([]);

      // A repository with no community skills here is not claimable at all.
      const empty = newRepo();
      await expect(
        claims.startSkillClaim(
          { userId: stranger, repo: empty.label, method: "verification_file" },
          personal,
        ),
      ).rejects.toMatchObject({ code: "SKILL_CLAIM_REPO_NOT_FOUND", statusCode: 404 });
    });

    test("the verification file proves an organization's repository", async () => {
      const target = newRepo();
      const importer = await user();
      const author = await user();
      const skill = await registrySkill({ ...target, submitterId: importer });
      let file: string | null = null;
      const github = fakeGitHub({
        facts: {
          fullName: target.label,
          ownerGithubId: "9001",
          ownerType: "Organization",
          defaultBranch: "trunk",
        },
        file: () => file,
      });

      const abandoned = await claims.startSkillClaim(
        { userId: author, repo: target.label, method: "verification_file" },
        github,
      );
      const started = await claims.startSkillClaim(
        { userId: author, repo: target.label, method: "verification_file" },
        github,
      );
      expect(started.claim.status).toBe("pending");
      expect(started.claim.expiresAt).not.toBeNull();
      expect(started.verification).toMatchObject({
        path: ".sourceweft/claim",
        branch: "trunk",
      });
      const token = started.verification!.token;
      // Starting again replaced the first pending claim; only a hash is kept.
      const rows = await data.db
        .select()
        .from(data.skillRepoClaims)
        .where(eq(data.skillRepoClaims.repoOwner, target.owner));
      expect(rows.map((row) => row.id)).toEqual([started.claim.id]);
      expect(rows[0]!.tokenHash).toBe(claims.hashClaimToken(token));
      expect(JSON.stringify(rows)).not.toContain(token);
      await expect(
        claims.verifySkillClaim(
          { userId: author, claimId: abandoned.claim.id },
          github,
        ),
      ).rejects.toMatchObject({ code: "SKILL_CLAIM_NOT_FOUND" });

      const verify = () =>
        claims.verifySkillClaim(
          { userId: author, claimId: started.claim.id },
          github,
        );
      await expect(verify()).rejects.toMatchObject({
        code: "SKILL_CLAIM_FILE_MISSING",
      });
      file = abandoned.verification!.token;
      await expect(verify()).rejects.toMatchObject({
        code: "SKILL_CLAIM_FILE_MISMATCH",
      });
      expect((await definition(skill.skillId)).claimedAt).toBeNull();
      // Nobody else can verify it for them.
      await expect(
        claims.verifySkillClaim(
          { userId: importer, claimId: started.claim.id },
          github,
        ),
      ).rejects.toMatchObject({ code: "SKILL_CLAIM_NOT_FOUND" });

      file = `${token}\n`;
      expect(await verify()).toMatchObject({ status: "verified" });
      expect(github.branches.every((branch) => branch === "trunk")).toBe(true);
      const row = await definition(skill.skillId);
      expect(row.ownerUserId).toBe(author);
      expect(row.claimedAt).toBeInstanceOf(Date);
      // Verifying twice is harmless.
      expect(await verify()).toMatchObject({ status: "verified" });
    });

    test("a pending claim expires after seven days", async () => {
      const target = newRepo();
      const author = await user();
      await registrySkill({ ...target, submitterId: await user() });
      const github = fakeGitHub({
        facts: { fullName: target.label, ownerGithubId: "1", ownerType: "User" },
      });
      const started = await claims.startSkillClaim(
        { userId: author, repo: target.label, method: "verification_file" },
        github,
      );
      await data.db
        .update(data.skillRepoClaims)
        .set({ createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
        .where(eq(data.skillRepoClaims.id, started.claim.id));
      await expect(
        claims.verifySkillClaim(
          { userId: author, claimId: started.claim.id },
          fakeGitHub({
            facts: { fullName: target.label, ownerGithubId: "1", ownerType: "User" },
            file: () => started.verification!.token,
          }),
        ),
      ).rejects.toMatchObject({ code: "SKILL_CLAIM_EXPIRED", statusCode: 410 });
      const overview = await claims.getSkillClaimsOverview({ userId: author });
      expect(overview.claims[0]).toMatchObject({
        id: started.claim.id,
        status: "expired",
      });
    });

    test("a repository has one author: the second claimant is refused", async () => {
      const target = newRepo();
      const importer = await user();
      const first = await user("7301");
      const second = await user();
      const skill = await registrySkill({ ...target, submitterId: importer });
      const facts = {
        fullName: target.label,
        ownerGithubId: "7301",
        ownerType: "User" as const,
      };

      // The second one started first, waiting on their file...
      const pending = await claims.startSkillClaim(
        { userId: second, repo: target.label, method: "verification_file" },
        fakeGitHub({ facts }),
      );
      // ...the first one verified meanwhile.
      await claims.startSkillClaim(
        { userId: first, repo: target.label, method: "github_account" },
        fakeGitHub({ facts }),
      );

      await expect(
        claims.verifySkillClaim(
          { userId: second, claimId: pending.claim.id },
          fakeGitHub({ facts, file: () => pending.verification!.token }),
        ),
      ).rejects.toMatchObject({
        code: "SKILL_REPO_ALREADY_CLAIMED",
        statusCode: 409,
      });
      await expect(
        claims.startSkillClaim(
          { userId: second, repo: target.label, method: "verification_file" },
          fakeGitHub({ facts }),
        ),
      ).rejects.toMatchObject({ code: "SKILL_REPO_ALREADY_CLAIMED" });
      expect((await definition(skill.skillId)).ownerUserId).toBe(first);

      // What each of them sees about the repository.
      const seenBySecond = await claims.getSkillClaimsOverview({
        userId: second,
        skillId: skill.skillId,
      });
      expect(seenBySecond.repository).toMatchObject({
        repo: target.label,
        skillCount: 1,
        claimedBy: "someone",
      });
      const seenByFirst = await claims.getSkillClaimsOverview({
        userId: first,
        repo: { owner: target.owner, name: target.name },
      });
      expect(seenByFirst.repository).toMatchObject({
        claimedBy: "you",
        viewerClaim: { status: "verified" },
        ownerType: "User",
      });
    });

    test("linking GitHub suggests unclaimed personal repositories, and nothing more", async () => {
      const mine = newRepo();
      const theirs = newRepo();
      const githubId = `77${randomBytes(4).readUInt32BE()}`;
      const author = await user(githubId);
      const skill = await registrySkill({ ...mine, submitterId: await user() });
      await registrySkill({ ...theirs, submitterId: await user() });
      await data.db.insert(data.skillRepositories).values([
        {
          repoOwner: mine.owner,
          repoName: mine.name,
          ownerGithubId: githubId,
          ownerType: "User",
        },
        {
          repoOwner: theirs.owner,
          repoName: theirs.name,
          ownerGithubId: "somebody-else",
          ownerType: "User",
        },
      ]);

      const overview = await claims.getSkillClaimsOverview({ userId: author });
      expect(overview.githubLinked).toBe(true);
      expect(overview.suggestions).toEqual([{ repo: mine.label, skillCount: 1 }]);
      // A suggestion is not a claim.
      expect(overview.claims).toEqual([]);
      expect((await definition(skill.skillId)).ownerUserId).not.toBe(author);
    });

    test("removal takes the repository off the market; installs keep working", async () => {
      const target = newRepo();
      const importer = await user();
      const author = await user("7401");
      const skill = await registrySkill({ ...target, submitterId: importer });
      await listing.listSkillPublicly({
        skillId: skill.skillId,
        actorUserId: "skill-test-admin",
      });
      await skills.upsertWorkspaceSkill({
        teamId,
        workspaceId,
        skillId: skill.skillId,
        skillVersionId: skill.skillVersionId,
        enabled: true,
        enabledBy: importer,
      });
      const { claim } = await claims.startSkillClaim(
        { userId: author, repo: target.label, method: "github_account" },
        fakeGitHub({
          facts: { fullName: target.label, ownerGithubId: "7401", ownerType: "User" },
        }),
      );

      // Only the verified author may remove.
      await expect(
        claims.removeClaimedRepoFromMarket({ userId: importer, claimId: claim.id }),
      ).rejects.toMatchObject({ code: "SKILL_CLAIM_NOT_FOUND" });

      expect(
        await claims.removeClaimedRepoFromMarket({ userId: author, claimId: claim.id }),
      ).toEqual({ repo: target.label, skillCount: 1 });
      const removed = await definition(skill.skillId);
      expect(removed.visibility).toBe("restricted");
      expect(removed.listingHold).toBe(true);
      expect(removed.listingHoldBy).toBe("owner");
      // Not archived: an archived definition would stop resolving for the
      // workspace below.
      expect(removed.status).toBe("active");

      // The workspace that installed it still has it.
      const enabled = await skills.listEnabledWorkspaceSkillRecords({
        teamId,
        workspaceId,
      });
      expect(enabled.map((record) => record.skillId)).toContain(skill.skillId);

      // The auto-listing pass leaves it alone, and re-importing it does not
      // put it back.
      expect(
        await autoList.listAutoListCandidateIds({
          onlySkillIds: [skill.skillId],
          skipGrace: true,
        }),
      ).toEqual([]);
      await skill.resubmit();
      await skill.resubmit("d".repeat(40), "2026-02-01T00:00:00.000Z");
      const afterResubmit = await definition(skill.skillId);
      expect(afterResubmit.visibility).toBe("restricted");
      expect(afterResubmit.listingHoldBy).toBe("owner");
      expect(afterResubmit.ownerUserId).toBe(author);

      // The repository as a whole is off SourceWeft: the ingest refuses it
      // before writing anything (`triage-write`), so a skill it ships later
      // is not indexed and listed behind the author's back.
      const registry = await import("../registry/repository");
      const [ownerPart, namePart] = target.label.split("/");
      expect(
        await registry.isSkillRepositoryRemoved({
          owner: ownerPart!,
          name: namePart!,
        }),
      ).toBe(true);
      // An admin revoking the claim lifts it.
      await claims.revokeSkillClaim({
        claimId: claim.id,
        actorUserId: "skill-test-admin",
      });
      expect(
        await registry.isSkillRepositoryRemoved({
          owner: ownerPart!,
          name: namePart!,
        }),
      ).toBe(false);
    });

    test("an admin's revocation clears the claim and returns the skills to their importers", async () => {
      const target = newRepo();
      const importer = await user();
      const author = await user("7501");
      const skill = await registrySkill({ ...target, submitterId: importer });
      const { claim } = await claims.startSkillClaim(
        { userId: author, repo: target.label, method: "github_account" },
        fakeGitHub({
          facts: { fullName: target.label, ownerGithubId: "7501", ownerType: "User" },
        }),
      );
      expect((await definition(skill.skillId)).ownerUserId).toBe(author);

      expect(
        await claims.revokeSkillClaim({
          claimId: claim.id,
          actorUserId: "skill-test-admin",
        }),
      ).toEqual({ claimId: claim.id, repo: target.label, status: "revoked" });
      const row = await definition(skill.skillId);
      expect(row.claimedAt).toBeNull();
      expect(row.ownerUserId).toBe(importer);
      const [stored] = await data.db
        .select()
        .from(data.skillRepoClaims)
        .where(
          and(
            eq(data.skillRepoClaims.id, claim.id),
            eq(data.skillRepoClaims.status, "revoked"),
          ),
        );
      expect(stored).toMatchObject({ revokedBy: "skill-test-admin" });
      expect(stored!.revokedAt).toBeInstanceOf(Date);
      expect(
        (await standing.getSkillMarketStanding(skill.skillId))?.claim,
      ).toBeNull();
      // The revoked claim no longer lets its holder remove anything.
      await expect(
        claims.removeClaimedRepoFromMarket({ userId: author, claimId: claim.id }),
      ).rejects.toMatchObject({ code: "SKILL_CLAIM_NOT_VERIFIED" });
      expect(
        await claims.revokeSkillClaim({ claimId: "no-such-claim", actorUserId: "x" }),
      ).toBeNull();
    });
  },
);
