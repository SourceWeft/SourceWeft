import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, test, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { sha256 } from "../hash";

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
 * The market's upkeep against real PostgreSQL: which skills the auto-listing
 * pass lists, that a withdrawn skill stays withdrawn, that `listed_at` never
 * moves, and that install counts match what the catalog reports.
 *
 * Every pass is scoped to this file's own skills — other suites share the
 * isolated database and keep `restricted` registry rows of their own.
 */
describe.skipIf(process.env.RUN_SKILL_DB_TESTS !== "1")(
  "skill market listing (real PostgreSQL)",
  () => {
    let data: typeof import("@sourceweft/db");
    let repo: typeof import("../registry/repository");
    let skills: typeof import("../repository");
    let listing: typeof import("./listing");
    let autoList: typeof import("./auto-list");
    let installCounts: typeof import("./install-counts");
    const teamId = `skill-team-${randomUUID()}`;
    const workspaceIds = [
      `skill-ws-${randomUUID()}`,
      `skill-ws-${randomUUID()}`,
    ];
    const ids = new Set<string>();

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
      installCounts = await import("./install-counts");
      for (const id of workspaceIds)
        await data.db.insert(data.workspaces).values({
          id,
          organizationId: teamId,
          name: "Skill market tests",
          slug: randomUUID(),
        });
    });
    afterAll(async () => {
      if (!data) return;
      for (const id of ids)
        await data.db
          .delete(data.skillDefinitions)
          .where(eq(data.skillDefinitions.id, id));
      for (const id of workspaceIds)
        await data.db.delete(data.workspaces).where(eq(data.workspaces.id, id));
      await data.closeDatabase();
    });

    async function registrySkill(options: {
      flagged?: boolean;
      /** Published, but carrying a flag that does not hold it for review. */
      advisoryFlag?: string;
      /** Indexed before ingest checked where commits come from. */
      unstamped?: boolean;
      name?: string;
      description?: string;
    }) {
      const flagged = options.flagged ?? false;
      const slug = `gh-market-${randomUUID()}`;
      const displayName = options.name ?? "pptx";
      const description =
        options.description ?? "Create and edit PowerPoint presentations.";
      const commitSha = "a".repeat(40);
      const contentText = `---\nname: ${displayName}\ndescription: ${description}\n---\nBody\n`;
      const saved = await repo.upsertRegistrySkillIndex({
        slug,
        submitterId: "skill-owner",
        displayName,
        description,
        commitSha,
        storagePointer: `github:fixture/skills@${commitSha}#${slug}`,
        versionStatus: flagged ? "draft" : "published",
        outcome: flagged ? "queued" : "indexed",
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
            identifier: `gh:fixture/skills/${slug}`,
            sourceUrl: `https://github.com/fixture/skills/tree/${commitSha}/${slug}`,
            repoUrl: "https://github.com/fixture/skills",
            submittedBy: "skill-owner",
            committedAt: "2026-01-01T00:00:00.000Z",
            // What ingest stamps: the commit is the repository's own.
            ...(options.unstamped
              ? {}
              : {
                  provenance: {
                    defaultBranch: "main",
                    checkedAt: "2026-01-01T00:00:00.000Z",
                  },
                }),
            capability: "prompt-only",
            scan: {
              reviewRequired: flagged,
              flags: flagged
                ? ["test-review"]
                : options.advisoryFlag
                  ? [options.advisoryFlag]
                  : [],
            },
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
      ids.add(saved.skillId);
      return saved;
    }
    async function definition(skillId: string) {
      const [row] = await data.db
        .select()
        .from(data.skillDefinitions)
        .where(eq(data.skillDefinitions.id, skillId));
      return row!;
    }

    test("a clean skill is listed; a flagged one waits for review", async () => {
      const clean = await registrySkill({});
      const flagged = await registrySkill({ flagged: true });
      const scope = {
        onlySkillIds: [clean.skillId, flagged.skillId],
        skipGrace: true,
      };

      expect(await autoList.listAutoListCandidateIds(scope)).toEqual([
        clean.skillId,
      ]);
      const result = await autoList.runSkillAutoListing(scope);
      expect(result).toMatchObject({ listed: 1, failed: 0 });

      const listed = await definition(clean.skillId);
      expect(listed.visibility).toBe("public");
      expect(listed.listedAt).toBeInstanceOf(Date);
      expect(
        (await listing.listSkillCategorySlugs([clean.skillId])).get(
          clean.skillId,
        ),
      ).toContain("documents-office");

      const held = await definition(flagged.skillId);
      expect(held.visibility).toBe("restricted");
      expect(held.listedAt).toBeNull();

      // Nothing left to do: the pass is idempotent.
      expect(await autoList.runSkillAutoListing(scope)).toMatchObject({
        listed: 0,
      });
    });

    test("a published skill with an advisory flag waits for an admin", async () => {
      const skill = await registrySkill({ advisoryFlag: "binary:executable" });
      const scope = { onlySkillIds: [skill.skillId], skipGrace: true };

      expect(await autoList.listAutoListCandidateIds(scope)).toEqual([]);
      expect(await autoList.runSkillAutoListing(scope)).toMatchObject({
        listed: 0,
      });
      expect((await definition(skill.skillId)).visibility).toBe("restricted");

      const queued = (await autoList.listSkillListingQueue()).find(
        (entry) => entry.skillId === skill.skillId,
      );
      expect(queued).toMatchObject({
        slug: skill.slug,
        flags: ["binary:executable"],
      });

      // The admin's decision either way takes it out of the queue.
      await listing.listSkillPublicly({
        skillId: skill.skillId,
        actorUserId: "skill-test-admin",
      });
      expect((await definition(skill.skillId)).visibility).toBe("public");
      expect(
        (await autoList.listSkillListingQueue()).some(
          (entry) => entry.skillId === skill.skillId,
        ),
      ).toBe(false);
    });

    test("a freshly published skill waits before it lists itself", async () => {
      const skill = await registrySkill({});
      const scope = { onlySkillIds: [skill.skillId] };
      // Just imported: its owner still has time to keep it private.
      expect(await autoList.listAutoListCandidateIds(scope)).toEqual([]);

      await data.db
        .update(data.skillVersions)
        .set({ publishedAt: new Date(Date.now() - 11 * 60 * 1000) })
        .where(eq(data.skillVersions.id, skill.skillVersionId));
      expect(await autoList.listAutoListCandidateIds(scope)).toEqual([
        skill.skillId,
      ]);
    });

    test("the owner can keep their skill private, and only they can lift that", async () => {
      const skill = await registrySkill({});
      const scope = { onlySkillIds: [skill.skillId], skipGrace: true };
      const owner = { skillId: skill.skillId, userId: "skill-owner" };

      // Someone else: not their skill, as far as they can tell.
      expect(
        await listing.setOwnerSkillListing({
          skillId: skill.skillId,
          userId: "someone-else",
          listed: false,
        }),
      ).toBeNull();
      expect(
        await listing.getOwnerSkillListing({
          skillId: skill.skillId,
          userId: "someone-else",
        }),
      ).toBeNull();

      // Before it ever lists: held, so the pass leaves it alone.
      expect(
        await listing.setOwnerSkillListing({ ...owner, listed: false }),
      ).toEqual({ skillId: skill.skillId, listed: false, heldBy: "owner" });
      expect(await autoList.runSkillAutoListing(scope)).toMatchObject({
        listed: 0,
      });
      expect((await definition(skill.skillId)).visibility).toBe("restricted");

      // Lifting their own hold does not list it — the pass does, by its rules.
      expect(
        await listing.setOwnerSkillListing({ ...owner, listed: true }),
      ).toEqual({ skillId: skill.skillId, listed: false, heldBy: null });
      expect(await autoList.runSkillAutoListing(scope)).toMatchObject({
        listed: 1,
      });
      expect(await listing.getOwnerSkillListing(owner)).toEqual({
        skillId: skill.skillId,
        listed: true,
        heldBy: null,
      });

      // Taking a listed skill off the market.
      await listing.setOwnerSkillListing({ ...owner, listed: false });
      const row = await definition(skill.skillId);
      expect(row.visibility).toBe("restricted");
      expect(row.listingHoldBy).toBe("owner");
    });

    test("an owner cannot put back what an admin withdrew", async () => {
      const skill = await registrySkill({});
      const owner = { skillId: skill.skillId, userId: "skill-owner" };
      await listing.listSkillPublicly({
        skillId: skill.skillId,
        actorUserId: "skill-test-admin",
      });
      await listing.delistSkill({
        skillId: skill.skillId,
        actorUserId: "skill-test-admin",
      });
      expect((await definition(skill.skillId)).listingHoldBy).toBe("admin");

      await expect(
        listing.setOwnerSkillListing({ ...owner, listed: true }),
      ).rejects.toMatchObject({ code: "SKILL_LISTING_HELD_BY_ADMIN" });
      // Asking for private when an admin already holds it changes nothing.
      expect(
        await listing.setOwnerSkillListing({ ...owner, listed: false }),
      ).toEqual({ skillId: skill.skillId, listed: false, heldBy: "admin" });
      expect((await definition(skill.skillId)).listingHoldBy).toBe("admin");

      // An admin listing it again clears the hold entirely.
      await listing.releaseSkillListingHold({ skillId: skill.skillId });
      const row = await definition(skill.skillId);
      expect(row.listingHold).toBe(false);
      expect(row.listingHoldBy).toBeNull();
    });

    test("a version indexed before provenance checks is checked before it is ever listed", async () => {
      const provenance = await import("./provenance");
      const { GitHubArchiveError } = await import("../../market/parser/github");
      const onBranch: import("./provenance").ProvenanceDeps = {
        resolveDefaultBranch: async () => "main",
        assertCommitOnDefaultBranch: async () => {},
      };
      const fromAFork: import("./provenance").ProvenanceDeps = {
        resolveDefaultBranch: async () => "main",
        assertCommitOnDefaultBranch: async () => {
          throw new GitHubArchiveError(
            "ARCHIVE_NOT_IN_REPOSITORY",
            "not on main",
          );
        },
      };
      const unreachable: import("./provenance").ProvenanceDeps = {
        resolveDefaultBranch: async () => {
          throw new Error("GitHub request failed 503");
        },
        assertCommitOnDefaultBranch: async () => {},
      };

      // Unstamped: the pass will not list it on its own.
      const legit = await registrySkill({ unstamped: true });
      expect(
        await autoList.listAutoListCandidateIds({
          onlySkillIds: [legit.skillId],
          skipGrace: true,
        }),
      ).toEqual([]);
      // GitHub down: nothing decided, asked again next time.
      expect(
        await provenance.runProvenanceSweep({
          onlySkillIds: [legit.skillId],
          deps: unreachable,
        }),
      ).toEqual({ confirmed: 0, foreign: 0, unknown: 1 });
      // Its commit is on the default branch: stamped, and then listable.
      expect(
        await provenance.runProvenanceSweep({
          onlySkillIds: [legit.skillId],
          deps: onBranch,
        }),
      ).toEqual({ confirmed: 1, foreign: 0, unknown: 0 });
      expect(
        await autoList.listAutoListCandidateIds({
          onlySkillIds: [legit.skillId],
          skipGrace: true,
        }),
      ).toEqual([legit.skillId]);

      // Already public (listed before the check existed), commit from a fork:
      // taken off the market and held there.
      const forged = await registrySkill({ unstamped: true });
      await data.db
        .update(data.skillDefinitions)
        .set({ visibility: "public", listedAt: new Date() })
        .where(eq(data.skillDefinitions.id, forged.skillId));
      expect(
        await provenance.runProvenanceSweep({
          onlySkillIds: [forged.skillId],
          deps: fromAFork,
        }),
      ).toEqual({ confirmed: 0, foreign: 1, unknown: 0 });
      const row = await definition(forged.skillId);
      expect(row.visibility).toBe("restricted");
      expect(row.listingHold).toBe(true);
      expect(row.listingHoldBy).toBe("admin");

      // And an admin cannot list it by hand either.
      await listing.releaseSkillListingHold({ skillId: forged.skillId });
      await expect(
        provenance.ensureListingProvenance(forged.skillId, fromAFork),
      ).rejects.toMatchObject({ code: "SKILL_COMMIT_NOT_IN_REPOSITORY" });
    });

    test("a withdrawn skill is held and does not come back", async () => {
      const skill = await registrySkill({});
      const scope = { onlySkillIds: [skill.skillId], skipGrace: true };
      await autoList.runSkillAutoListing(scope);
      const firstListedAt = (await definition(skill.skillId)).listedAt!;

      await listing.delistSkill({
        skillId: skill.skillId,
        actorUserId: "skill-test-admin",
      });
      let row = await definition(skill.skillId);
      expect(row.visibility).toBe("restricted");
      expect(row.listingHold).toBe(true);

      expect(await autoList.runSkillAutoListing(scope)).toMatchObject({
        listed: 0,
      });
      expect((await definition(skill.skillId)).visibility).toBe("restricted");

      // Released and listed again: `listed_at` is the first listing's, so the
      // skill keeps its place in "newest".
      await listing.releaseSkillListingHold({ skillId: skill.skillId });
      expect(await autoList.runSkillAutoListing(scope)).toMatchObject({
        listed: 1,
      });
      row = await definition(skill.skillId);
      expect(row.visibility).toBe("public");
      expect(row.listedAt!.getTime()).toBe(firstListedAt.getTime());
    });

    test("an admin's categories survive a re-listing", async () => {
      const skill = await registrySkill({});
      await listing.listSkillPublicly({
        skillId: skill.skillId,
        actorUserId: "skill-test-admin",
      });
      await listing.setSkillCategories({
        skillId: skill.skillId,
        categorySlugs: ["design-creative"],
      });
      await listing.delistSkill({
        skillId: skill.skillId,
        actorUserId: "skill-test-admin",
      });
      await listing.listSkillPublicly({
        skillId: skill.skillId,
        actorUserId: "skill-test-admin",
      });
      expect(
        (await listing.listSkillCategorySlugs([skill.skillId])).get(
          skill.skillId,
        ),
      ).toEqual(["design-creative"]);

      await expect(
        listing.setSkillCategories({
          skillId: skill.skillId,
          categorySlugs: ["no-such-category"],
        }),
      ).rejects.toMatchObject({ code: "SKILL_CATEGORY_INVALID" });
    });

    test("a public skill made public elsewhere gets its date and categories", async () => {
      const skill = await registrySkill({});
      await data.db
        .update(data.skillDefinitions)
        .set({ visibility: "public" })
        .where(eq(data.skillDefinitions.id, skill.skillId));
      const result = await autoList.runSkillAutoListing({
        onlySkillIds: [skill.skillId],
        skipGrace: true,
      });
      expect(result).toMatchObject({ listed: 0, backfilled: 1 });
      expect((await definition(skill.skillId)).listedAt).toBeInstanceOf(Date);
    });

    test("install counts match what the catalog reports", async () => {
      const skill = await registrySkill({});
      await listing.listSkillPublicly({
        skillId: skill.skillId,
        actorUserId: "skill-test-admin",
      });
      for (const workspaceId of workspaceIds)
        await skills.upsertWorkspaceSkill({
          teamId,
          workspaceId,
          skillId: skill.skillId,
          skillVersionId: skill.skillVersionId,
          enabled: true,
          enabledBy: "skill-owner",
        });
      await installCounts.refreshSkillInstallCounts();
      expect((await definition(skill.skillId)).installCount).toBe(2);
      expect(
        (await skills.countSkillInstalls([skill.skillId])).get(skill.skillId),
      ).toBe(2);
    });
  },
);
