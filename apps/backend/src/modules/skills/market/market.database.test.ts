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
      const scope = { onlySkillIds: [clean.skillId, flagged.skillId] };

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
      const scope = { onlySkillIds: [skill.skillId] };

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

    test("a withdrawn skill is held and does not come back", async () => {
      const skill = await registrySkill({});
      const scope = { onlySkillIds: [skill.skillId] };
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
