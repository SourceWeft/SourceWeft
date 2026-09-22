import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { sha256 } from "../hash";
import type { ClaimGitHub } from "./claims";

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
 * The market admin's side against real PostgreSQL (skill-marketplace-plan
 * §17.1): every decision leaves an audit event naming who made it, a new
 * version clearing `verified` says which version did, categories can be
 * re-inferred without undoing an admin's pick, an author can restore a
 * removed repository and a revoked claim takes the author's holds with it,
 * the all-skills list filters and pages, and GitHub's rate limit stops an
 * upkeep step without failing it.
 *
 * Every skill, repository, user and event here is this file's own; the
 * database is shared with other suites and a live e2e stack.
 */
describe.skipIf(process.env.RUN_SKILL_DB_TESTS !== "1")(
  "skill market admin (real PostgreSQL)",
  () => {
    let data: typeof import("@sourceweft/db");
    let repo: typeof import("../registry/repository");
    let listing: typeof import("./listing");
    let autoList: typeof import("./auto-list");
    let events: typeof import("./events");
    let claims: typeof import("./claims");
    let adminList: typeof import("./admin-list");
    let provenance: typeof import("./provenance");
    let repoMetadata: typeof import("./repo-metadata");
    let github: typeof import("../../market/parser/github");
    let taxonomy: typeof import("./taxonomy");
    const skillIds = new Set<string>();
    const repoOwners = new Set<string>();
    const userIds = new Set<string>();
    // Unique to this run: the admin's user id, and a word in every slug so
    // the admin list can be narrowed to this file's skills.
    const token = randomBytes(5).toString("hex");
    let admin: string;

    beforeAll(async () => {
      if (
        !new URL(process.env.DATABASE_URL!).pathname.startsWith(
          "/sourceweft_skillv6_",
        )
      )
        throw new Error("Refusing non-isolated database");
      data = await import("@sourceweft/db");
      repo = await import("../registry/repository");
      listing = await import("./listing");
      autoList = await import("./auto-list");
      events = await import("./events");
      claims = await import("./claims");
      adminList = await import("./admin-list");
      provenance = await import("./provenance");
      repoMetadata = await import("./repo-metadata");
      github = await import("../../market/parser/github");
      taxonomy = await import("./taxonomy");
      admin = await user({ name: `Admin ${token}` });
    });
    afterAll(async () => {
      if (!data) return;
      // A skill's events go with it (cascade); repository-level ones and the
      // bulk pass's summary do not.
      if (skillIds.size > 0)
        await data.db
          .delete(data.skillDefinitions)
          .where(inArray(data.skillDefinitions.id, [...skillIds]));
      if (repoOwners.size > 0) {
        await data.db
          .delete(data.skillMarketEvents)
          .where(inArray(data.skillMarketEvents.repoOwner, [...repoOwners]));
        await data.db
          .delete(data.skillRepoClaims)
          .where(inArray(data.skillRepoClaims.repoOwner, [...repoOwners]));
        await data.db
          .delete(data.skillRepositories)
          .where(inArray(data.skillRepositories.repoOwner, [...repoOwners]));
      }
      if (userIds.size > 0)
        await data.db
          .delete(data.skillMarketEvents)
          .where(inArray(data.skillMarketEvents.actorUserId, [...userIds]));
      for (const id of userIds)
        await data.db.execute(sql`delete from "user" where id = ${id}`);
      await data.closeDatabase();
    });

    async function user(input: { name?: string; githubId?: string } = {}) {
      const id = `market-admin-user-${randomUUID()}`;
      userIds.add(id);
      await data.db.execute(sql`
        insert into "user" (id, name, email, "emailVerified")
        values (${id}, ${input.name ?? "Market test"}, ${`${id}@example.test`}, true)
      `);
      if (input.githubId)
        await data.db.execute(sql`
          insert into "account" (id, issuer, "accountId", "providerId", "userId", "updatedAt")
          values (${randomUUID()}, 'test:github', ${input.githubId}, 'github', ${id}, now())
        `);
      return id;
    }

    function newRepo() {
      const owner = `madmin-${randomBytes(6).toString("hex")}`;
      repoOwners.add(owner);
      return { owner, name: "skills", label: `${owner}/skills` };
    }

    async function registrySkill(
      options: {
        repo?: { owner: string; name: string };
        submitterId?: string;
        flags?: string[];
        unstamped?: boolean;
        displayName?: string;
        description?: string;
      } = {},
    ) {
      const target = options.repo ?? newRepo();
      const slug = `gh-madmin-${token}-${randomUUID()}`;
      const displayName = options.displayName ?? "pptx";
      const description =
        options.description ?? "Create and edit PowerPoint presentations.";
      const submitterId = options.submitterId ?? "skill-owner";
      const flags = options.flags ?? [];
      const upsert = (
        commitSha = "a".repeat(40),
        committedAt = "2026-01-01T00:00:00.000Z",
      ) => {
        const contentText = `---\nname: ${displayName}\ndescription: ${description}\n---\n${commitSha}\n`;
        return repo.upsertRegistrySkillIndex({
          slug,
          submitterId,
          displayName,
          description,
          commitSha,
          storagePointer: `github:${target.owner}/${target.name}@${commitSha}#${slug}`,
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
              identifier: `gh:${target.owner}/${target.name}/${slug}`,
              sourceUrl: `https://github.com/${target.owner}/${target.name}/tree/${commitSha}/${slug}`,
              repoUrl: `https://github.com/${target.owner}/${target.name}`,
              submittedBy: submitterId,
              committedAt,
              ...(options.unstamped
                ? {}
                : {
                    provenance: {
                      defaultBranch: "main",
                      checkedAt: "2026-01-01T00:00:00.000Z",
                    },
                  }),
              capability: "prompt-only",
              scan: { reviewRequired: false, flags },
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
      };
      const saved = await upsert();
      skillIds.add(saved.skillId);
      return { ...saved, slug, repo: target, resubmit: upsert };
    }

    async function definition(skillId: string) {
      const [row] = await data.db
        .select()
        .from(data.skillDefinitions)
        .where(eq(data.skillDefinitions.id, skillId));
      return row!;
    }

    async function actionsOf(skillId: string) {
      const items = await events.listSkillMarketEvents({ skillId, limit: 50 });
      return items!.map((event) => event.action);
    }

    function fakeGitHub(ownerGithubId: string, label: string): ClaimGitHub {
      return {
        fetchRepoFacts: async () => ({
          fullName: label,
          ownerGithubId,
          ownerType: "User",
          defaultBranch: "main",
        }),
      };
    }

    test("every admin decision is recorded, newest first, with who made it", async () => {
      const skill = await registrySkill();
      await listing.delistSkill({ skillId: skill.skillId, actorUserId: admin });
      await listing.listSkillPublicly({
        skillId: skill.skillId,
        actorUserId: admin,
        releaseHold: true,
      });
      await listing.setSkillVerified({
        skillId: skill.skillId,
        verified: true,
        actorUserId: admin,
      });
      await listing.setSkillFeatured({
        skillId: skill.skillId,
        featured: true,
        actorUserId: admin,
      });
      await listing.setSkillCategories({
        skillId: skill.skillId,
        categorySlugs: ["development"],
        actorUserId: admin,
      });

      const history = await events.listSkillMarketEvents({
        skillId: skill.skillId,
        limit: 50,
      });
      expect(history!.map((event) => event.action)).toEqual([
        "categories.set",
        "featured.set",
        "verified.set",
        "listing.listed",
        "listing.withdrawn",
      ]);
      for (const event of history!) {
        expect(event).toMatchObject({
          skillId: skill.skillId,
          skillSlug: skill.slug,
          actorKind: "admin",
          actorUserId: admin,
          actorName: `Admin ${token}`,
        });
      }
      const [categories, featured, verified, listed, withdrawn] = history!;
      expect(withdrawn!.detail).toEqual({
        visibility: { from: "restricted", to: "restricted" },
        listingHoldBy: { from: null, to: "admin" },
      });
      expect(listed!.detail).toEqual({
        visibility: { from: "restricted", to: "public" },
        listingHoldBy: { from: "admin", to: null },
      });
      expect(verified!.detail).toEqual({ verified: { from: false, to: true } });
      expect(featured!.detail).toMatchObject({
        featured: { from: false, to: true },
      });
      expect(categories!.detail).toMatchObject({
        categorySlugs: { to: ["development"] },
        categoriesSetBy: { to: "admin" },
      });
      // The admin's pick is recorded as theirs.
      expect((await definition(skill.skillId)).categoriesSetBy).toBe("admin");

      // The limit is honored; an unknown skill has no history.
      expect(
        await events.listSkillMarketEvents({
          skillId: skill.skillId,
          limit: 2,
        }),
      ).toHaveLength(2);
      expect(
        await events.listSkillMarketEvents({ skillId: "no-such", limit: 2 }),
      ).toBeNull();
    });

    test("the platform's own acts are recorded as the system's", async () => {
      const clean = await registrySkill();
      await autoList.runSkillAutoListing({
        onlySkillIds: [clean.skillId],
        skipGrace: true,
      });
      const [listed] = (await events.listSkillMarketEvents({
        skillId: clean.skillId,
        limit: 5,
      }))!;
      expect(listed).toMatchObject({
        action: "listing.auto_listed",
        actorKind: "system",
        actorUserId: listing.SKILL_AUTO_LIST_ACTOR,
        actorName: null,
      });
      // Listing filed it under inferred categories, recorded as such.
      expect((await definition(clean.skillId)).categoriesSetBy).toBe("auto");

      // A foreign commit found by the sweep.
      const forged = await registrySkill({ unstamped: true });
      await provenance.runProvenanceSweep({
        onlySkillIds: [forged.skillId],
        deps: {
          resolveDefaultBranch: async () => "main",
          assertCommitOnDefaultBranch: async () => {
            throw new github.GitHubArchiveError(
              "ARCHIVE_NOT_IN_REPOSITORY",
              "fork",
            );
          },
        },
      });
      const [withheld] = (await events.listSkillMarketEvents({
        skillId: forged.skillId,
        limit: 5,
      }))!;
      expect(withheld).toMatchObject({
        action: "provenance.withheld",
        actorKind: "system",
        actorUserId: null,
        detail: { skillVersionId: forged.skillVersionId },
      });
    });

    test("a new version clears verified and the event names both versions", async () => {
      const skill = await registrySkill();
      await listing.setSkillVerified({
        skillId: skill.skillId,
        verified: true,
        actorUserId: admin,
      });
      const newer = await skill.resubmit(
        "b".repeat(40),
        "2026-02-01T00:00:00.000Z",
      );
      expect((await definition(skill.skillId)).verified).toBe(false);
      const [cleared] = (await events.listSkillMarketEvents({
        skillId: skill.skillId,
        limit: 5,
      }))!;
      expect(cleared).toMatchObject({
        action: "verified.cleared",
        actorKind: "system",
        detail: {
          fromVersionId: skill.skillVersionId,
          toVersionId: newer.skillVersionId,
        },
      });
      // A new version of an unverified skill clears nothing and says nothing.
      await skill.resubmit("c".repeat(40), "2026-03-01T00:00:00.000Z");
      expect(
        (await actionsOf(skill.skillId)).filter(
          (action) => action === "verified.cleared",
        ),
      ).toHaveLength(1);
    });

    test("re-inferring categories: one skill even when an admin picked them, in bulk never", async () => {
      const picked = await registrySkill();
      const inferred = await registrySkill();
      for (const skill of [picked, inferred])
        await listing.prepareSkillListing(skill.skillId);
      await listing.setSkillCategories({
        skillId: picked.skillId,
        categorySlugs: ["writing-content"],
        actorUserId: admin,
      });
      // Someone's categories that no longer match what the classifier says.
      await data.db
        .delete(data.skillDefinitionCategories)
        .where(eq(data.skillDefinitionCategories.skillId, inferred.skillId));
      await data.db.insert(data.skillDefinitionCategories).values({
        skillId: inferred.skillId,
        categoryId: taxonomy.skillCategoryId("other"),
      });
      const categoriesOf = async (skillId: string) =>
        (await listing.listSkillCategorySlugs([skillId])).get(skillId) ?? [];
      // What the classifier files this text under.
      const inferredSlugs = taxonomy.classifySkillCategories({
        name: "pptx",
        description: "Create and edit PowerPoint presentations.",
      });
      expect(inferredSlugs).not.toContain("other");
      expect(
        await listing.reinferSkillCategories({
          skillId: "no-such",
          actorUserId: admin,
        }),
      ).toBeNull();

      const bulk = await listing.reinferAllSkillCategories({
        actorUserId: admin,
        onlySkillIds: [picked.skillId, inferred.skillId],
        batchSize: 1,
      });
      expect(bulk).toEqual({ considered: 1, changed: 1 });
      expect(await categoriesOf(picked.skillId)).toEqual(["writing-content"]);
      expect(await categoriesOf(inferred.skillId)).toEqual(inferredSlugs);
      expect((await definition(inferred.skillId)).categoriesSetBy).toBe("auto");
      expect((await actionsOf(inferred.skillId))[0]).toBe(
        "categories.reinferred",
      );
      // Run again: nothing left to change.
      expect(
        await listing.reinferAllSkillCategories({
          actorUserId: admin,
          onlySkillIds: [picked.skillId, inferred.skillId],
        }),
      ).toEqual({ considered: 1, changed: 0 });

      // One skill on request: the admin's pick is replaced and is `auto` now.
      expect(
        await listing.reinferSkillCategories({
          skillId: picked.skillId,
          actorUserId: admin,
        }),
      ).toEqual({ skillId: picked.skillId, categorySlugs: inferredSlugs });
      expect((await definition(picked.skillId)).categoriesSetBy).toBe("auto");
      const [reinferred] = (await events.listSkillMarketEvents({
        skillId: picked.skillId,
        limit: 1,
      }))!;
      expect(reinferred).toMatchObject({
        action: "categories.reinferred",
        detail: {
          categorySlugs: { from: ["writing-content"], to: inferredSlugs },
          categoriesSetBy: { from: "admin", to: "auto" },
        },
      });
    });

    test("re-inferring prefers the current version's AI overview, unless it is hidden", async () => {
      const skill = await registrySkill();
      await listing.prepareSkillListing(skill.skillId);
      const keywordSlugs = taxonomy.classifySkillCategories({
        name: "pptx",
        description: "Create and edit PowerPoint presentations.",
      });
      expect(keywordSlugs).not.toContain("ai-agents");
      await data.db.insert(data.skillVersionOverviews).values({
        skillVersionId: skill.skillVersionId,
        locale: "en",
        bundleSha256: "e2e".padEnd(64, "0"),
        model: "test-model",
        overview: {
          summary: "Delegates independent tasks to parallel sub-agents.",
          whatItDoes: "",
          whenToUse: "",
          requirements: "",
          // An unknown slug is dropped, never filed.
          suggestedCategories: ["ai-agents", "no-such-category"],
        },
      });
      const categoriesOf = async (skillId: string) =>
        (await listing.listSkillCategorySlugs([skillId])).get(skillId) ?? [];

      expect(
        await listing.reinferSkillCategories({
          skillId: skill.skillId,
          actorUserId: admin,
        }),
      ).toEqual({ skillId: skill.skillId, categorySlugs: ["ai-agents"] });
      const [event] = (await events.listSkillMarketEvents({
        skillId: skill.skillId,
        limit: 1,
      }))!;
      expect(event).toMatchObject({
        action: "categories.reinferred",
        detail: { source: "overview" },
      });

      // Hidden by an admin: the keyword classifier decides again, in bulk too.
      await data.db
        .update(data.skillVersionOverviews)
        .set({ hidden: true })
        .where(
          eq(data.skillVersionOverviews.skillVersionId, skill.skillVersionId),
        );
      expect(
        await listing.reinferAllSkillCategories({
          actorUserId: admin,
          onlySkillIds: [skill.skillId],
        }),
      ).toEqual({ considered: 1, changed: 1 });
      expect(await categoriesOf(skill.skillId)).toEqual(keywordSlugs);
    });

    test("an author restores a removed repository; the admin's hold stays", async () => {
      const target = newRepo();
      const githubId = `8${randomBytes(4).readUInt32BE()}`;
      const author = await user({ githubId });
      const kept = await registrySkill({ repo: target });
      const heldByAdmin = await registrySkill({ repo: target });
      const { claim } = await claims.startSkillClaim(
        { userId: author, repo: target.label, method: "github_account" },
        fakeGitHub(githubId, target.label),
      );
      await listing.delistSkill({
        skillId: heldByAdmin.skillId,
        actorUserId: admin,
      });
      await claims.removeClaimedRepoFromMarket({
        userId: author,
        claimId: claim.id,
      });
      expect((await definition(kept.skillId)).listingHoldBy).toBe("owner");
      expect((await definition(heldByAdmin.skillId)).listingHoldBy).toBe(
        "admin",
      );

      // Only the author, and only with a verified claim.
      const stranger = await user();
      await expect(
        claims.restoreClaimedRepoToMarket({
          userId: stranger,
          claimId: claim.id,
        }),
      ).rejects.toMatchObject({ code: "SKILL_CLAIM_NOT_FOUND" });

      expect(
        await claims.restoreClaimedRepoToMarket({
          userId: author,
          claimId: claim.id,
        }),
      ).toEqual({ repo: target.label, skillCount: 1 });
      const restored = await definition(kept.skillId);
      expect(restored.listingHold).toBe(false);
      expect(restored.listingHoldBy).toBeNull();
      expect((await definition(heldByAdmin.skillId)).listingHoldBy).toBe(
        "admin",
      );
      expect(
        await repo.isSkillRepositoryRemoved({
          owner: target.owner,
          name: target.name,
        }),
      ).toBe(false);
      // The platform's rules list it again; the admin's withdrawal stands.
      expect(
        await autoList.listAutoListCandidateIds({
          onlySkillIds: [kept.skillId, heldByAdmin.skillId],
          skipGrace: true,
        }),
      ).toEqual([kept.skillId]);
      // Asking again changes nothing.
      expect(
        await claims.restoreClaimedRepoToMarket({
          userId: author,
          claimId: claim.id,
        }),
      ).toEqual({ repo: target.label, skillCount: 0 });

      // The skill's history carries its repository's claim events, and the
      // per-skill removal.
      const history = await actionsOf(kept.skillId);
      expect(history.slice(0, 3)).toEqual([
        "claim.restored",
        "claim.removed",
        "listing.owner_private",
      ]);
      expect(history).toContain("claim.granted");
      const [restoredEvent] = (await events.listSkillMarketEvents({
        skillId: kept.skillId,
        limit: 1,
      }))!;
      expect(restoredEvent).toMatchObject({
        skillId: null,
        repo: target.label,
        actorKind: "owner",
        actorUserId: author,
        detail: { claimId: claim.id, skillCount: 1 },
      });
    });

    test("revoking a claim lifts the author's holds, never an admin's", async () => {
      const target = newRepo();
      const githubId = `9${randomBytes(4).readUInt32BE()}`;
      const author = await user({ githubId });
      const ownerHeld = await registrySkill({ repo: target });
      const adminHeld = await registrySkill({ repo: target });
      const { claim } = await claims.startSkillClaim(
        { userId: author, repo: target.label, method: "github_account" },
        fakeGitHub(githubId, target.label),
      );
      await listing.setOwnerSkillListing({
        skillId: ownerHeld.skillId,
        userId: author,
        listed: false,
      });
      await listing.delistSkill({
        skillId: adminHeld.skillId,
        actorUserId: admin,
      });

      await claims.revokeSkillClaim({ claimId: claim.id, actorUserId: admin });
      const released = await definition(ownerHeld.skillId);
      expect(released.listingHold).toBe(false);
      expect(released.listingHoldBy).toBeNull();
      expect(released.ownerUserId).toBe("skill-owner");
      expect((await definition(adminHeld.skillId)).listingHoldBy).toBe("admin");
      const [revoked] = (await events.listSkillMarketEvents({
        skillId: ownerHeld.skillId,
        limit: 1,
      }))!;
      expect(revoked).toMatchObject({
        action: "claim.revoked",
        actorKind: "admin",
        actorUserId: admin,
        repo: target.label,
        detail: { claimId: claim.id, userId: author, holdsLifted: 1 },
      });
    });

    test("the global feed pages newest first without skipping or repeating", async () => {
      const skill = await registrySkill();
      for (const verified of [true, false, true])
        await listing.setSkillVerified({
          skillId: skill.skillId,
          verified,
          actorUserId: admin,
        });
      const first = await events.listRecentSkillMarketEvents({ limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = await events.listRecentSkillMarketEvents({
        cursor: first.nextCursor,
        limit: 2,
      });
      const last = first.items.at(-1)!;
      for (const item of second.items) {
        expect(item.id).not.toBe(last.id);
        expect(Date.parse(item.createdAt)).toBeLessThanOrEqual(
          Date.parse(last.createdAt),
        );
      }
      // Walking the feed finds this skill's three events in order, once each.
      const mine: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 50 && mine.length < 3; page += 1) {
        const result = await events.listRecentSkillMarketEvents({
          cursor,
          limit: 25,
        });
        for (const item of result.items)
          if (item.skillId === skill.skillId)
            mine.push(String((item.detail.verified as { to: boolean }).to));
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      expect(mine).toEqual(["true", "false", "true"]);
      await expect(
        events.listRecentSkillMarketEvents({ cursor: "garbage", limit: 2 }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });

    test("the all-skills list filters by standing and marks, and pages", async () => {
      const q = `madmin-${token}`;
      const plain = await registrySkill();
      const flagged = await registrySkill({ flags: ["binary:executable"] });
      const featured = await registrySkill();
      const withdrawn = await registrySkill();
      await listing.setSkillFeatured({
        skillId: featured.skillId,
        featured: true,
        actorUserId: admin,
      });
      await listing.setSkillVerified({
        skillId: featured.skillId,
        verified: true,
        actorUserId: admin,
      });
      await listing.listSkillPublicly({
        skillId: plain.skillId,
        actorUserId: admin,
      });
      await listing.delistSkill({
        skillId: withdrawn.skillId,
        actorUserId: admin,
      });
      await data.db.insert(data.skillReports).values({
        id: randomUUID(),
        skillId: flagged.skillId,
        reason: "spam",
        reporterUserId: admin,
      });
      // Earlier cases' skills share the token; only this case's count here.
      const mine = new Set(
        [plain, flagged, featured, withdrawn].map((skill) => skill.skillId),
      );
      const ids = async (
        filters: Parameters<typeof adminList.listSkillMarketAdminSkills>[0],
      ) =>
        (await adminList.listSkillMarketAdminSkills(filters)).items
          .map((item) => item.id)
          .filter((id) => mine.has(id));
      const all = { q, limit: 100 };

      expect(new Set(await ids(all))).toEqual(
        new Set([
          plain.skillId,
          flagged.skillId,
          featured.skillId,
          withdrawn.skillId,
        ]),
      );
      expect(await ids({ ...all, standing: "public" })).toEqual([
        plain.skillId,
      ]);
      expect(await ids({ ...all, standing: "held" })).toEqual([
        withdrawn.skillId,
      ]);
      expect(await ids({ ...all, featured: true })).toEqual([featured.skillId]);
      expect(await ids({ ...all, verified: true })).toEqual([featured.skillId]);
      expect(await ids({ ...all, flagged: true })).toEqual([flagged.skillId]);
      expect(await ids({ ...all, reported: true })).toEqual([flagged.skillId]);
      expect(await ids({ ...all, claimed: true })).toEqual([]);
      expect(new Set(await ids({ ...all, standing: "restricted" }))).toEqual(
        new Set([flagged.skillId, featured.skillId]),
      );
      expect(await ids({ q: "no-such-skill-anywhere", limit: 10 })).toEqual([]);

      const [row] = (
        await adminList.listSkillMarketAdminSkills({ ...all, reported: true })
      ).items;
      expect(row).toMatchObject({
        id: flagged.skillId,
        slug: flagged.slug,
        repo: `${flagged.repo.owner}/${flagged.repo.name}`,
        visibility: "restricted",
        listingHold: false,
        listingHoldBy: null,
        featured: false,
        verified: false,
        claimed: false,
        flagCount: 1,
        openReportCount: 1,
        installCount: 0,
        ratingAvg: null,
        ratingCount: 0,
      });

      // Newest change first; one at a time, every row exactly once.
      const everyone = await ids(all);
      expect(everyone[0]).toBe(withdrawn.skillId);
      const paged: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await adminList.listSkillMarketAdminSkills({
          q,
          limit: 1,
          cursor,
        });
        paged.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(paged.filter((id) => mine.has(id))).toEqual(everyone);
      await expect(
        adminList.listSkillMarketAdminSkills({ limit: 1, cursor: "nope" }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });

    test("GitHub's rate limit stops an upkeep step for the pass without failing it", async () => {
      const resetAt = new Date(Date.now() + 40 * 60_000);
      const limited = () =>
        new github.GitHubRateLimitedError(resetAt, "https://api.github.com/x");

      // Provenance: stops at the first limited answer, decides nothing.
      const first = await registrySkill({ unstamped: true });
      const second = await registrySkill({ unstamped: true });
      let checks = 0;
      const tally = await provenance.runProvenanceSweep({
        onlySkillIds: [first.skillId, second.skillId],
        deps: {
          resolveDefaultBranch: async () => {
            checks += 1;
            throw limited();
          },
          assertCommitOnDefaultBranch: async () => {},
        },
      });
      expect(checks).toBe(1);
      expect(tally).toEqual({
        confirmed: 0,
        foreign: 0,
        unknown: 0,
        rateLimitedUntil: resetAt.toISOString(),
      });
      for (const skill of [first, second])
        expect((await definition(skill.skillId)).listingHold).toBe(false);
      // An admin listing by hand meanwhile is told GitHub cannot say.
      await expect(
        provenance.ensureListingProvenance(first.skillId, {
          resolveDefaultBranch: async () => {
            throw limited();
          },
          assertCommitOnDefaultBranch: async () => {},
        }),
      ).rejects.toMatchObject({ code: "SKILL_PROVENANCE_UNAVAILABLE" });

      // Repository metadata: one request, then the pass stops.
      let requests = 0;
      const refreshed = await repoMetadata.refreshSkillRepositoryMetadata({
        batchSize: 5,
        deps: {
          fetch: async () => {
            requests += 1;
            throw limited();
          },
        },
      });
      expect(requests).toBe(1);
      expect(refreshed).toMatchObject({
        refreshed: 0,
        failed: 0,
        rateLimitedUntil: resetAt.toISOString(),
      });
    });
  },
);
