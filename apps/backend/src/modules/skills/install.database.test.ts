import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";

// The install predicate is SQL, so its real behaviour — who can see a
// `restricted` registry skill by slug — is only provable against PostgreSQL.
describe.skipIf(process.env.RUN_SKILL_DB_TESTS !== "1")(
  "install visibility against real PostgreSQL",
  () => {
    let data: typeof import("@sourceweft/db");
    let skills: typeof import("./repository");
    const owner = {
      teamId: `skill-team-${randomUUID()}`,
      workspaceId: `skill-ws-${randomUUID()}`,
      userId: "install-owner",
    };
    const stranger = {
      teamId: `skill-team-${randomUUID()}`,
      workspaceId: `skill-ws-${randomUUID()}`,
      userId: "install-stranger",
    };
    const definitionIds: string[] = [];

    async function seed(input: {
      slug: string;
      visibility: "public" | "restricted";
      status?: "published" | "draft";
    }) {
      const skillId = randomUUID();
      const versionId = randomUUID();
      definitionIds.push(skillId);
      await data.db.insert(data.skillDefinitions).values({
        id: skillId,
        sourceType: "registry_github",
        slug: input.slug,
        displayName: input.slug,
        description: "fixture",
        visibility: input.visibility,
        status: "active",
        ownerUserId: owner.userId,
      });
      await data.db.insert(data.skillVersions).values({
        id: versionId,
        skillId,
        version: "aaaaaaaaaaaa",
        status: input.status ?? "published",
        storageType: "db_text",
        storagePointer: `github:fixture/skills@${"a".repeat(40)}#x`,
        isCurrent: (input.status ?? "published") === "published",
        contentHash: "hash",
        manifestJson: {
          slug: input.slug,
          displayName: input.slug,
          version: "aaaaaaaaaaaa",
          description: "fixture",
          visibility: input.visibility,
          categories: [],
        },
      });
      return { skillId, versionId };
    }

    beforeAll(async () => {
      if (
        !new URL(process.env.DATABASE_URL!).pathname.startsWith(
          "/sourceweft_skillv6_",
        )
      )
        throw new Error("Refusing non-isolated database");
      data = await import("@sourceweft/db");
      skills = await import("./repository");
      for (const scope of [owner, stranger])
        await data.db.insert(data.workspaces).values({
          id: scope.workspaceId,
          organizationId: scope.teamId,
          name: "Install tests",
          slug: randomUUID(),
        });
    });

    afterAll(async () => {
      if (!data) return;
      for (const id of definitionIds)
        await data.db
          .delete(data.skillDefinitions)
          .where(eq(data.skillDefinitions.id, id));
      for (const scope of [owner, stranger])
        await data.db
          .delete(data.workspaces)
          .where(eq(data.workspaces.id, scope.workspaceId));
      await data.closeDatabase();
    });

    test("a restricted skill resolves by slug for its submitter only", async () => {
      const tag = randomUUID().slice(0, 8);
      const slug = `gh-fixture-${tag}-private`;
      await seed({ slug, visibility: "restricted" });

      const mine = await skills.findInstallableSkillsByName({
        ...owner,
        name: slug,
      });
      expect(mine.map((row) => row.definition.slug)).toEqual([slug]);

      const theirs = await skills.findInstallableSkillsByName({
        ...stranger,
        name: slug,
      });
      expect(theirs).toEqual([]);
      // The short name must not be a side door either.
      expect(
        await skills.findInstallableSkillsByName({
          ...stranger,
          name: "private",
        }),
      ).toEqual([]);
    });

    test("public skills resolve for anyone; short names surface every collision; drafts never resolve", async () => {
      const tag = randomUUID().slice(0, 8);
      const name = `pdf${tag}`;
      await seed({ slug: `gh-one-${tag}-${name}`, visibility: "public" });
      await seed({ slug: `gh-two-${tag}-${name}`, visibility: "public" });
      await seed({
        slug: `gh-three-${tag}-${name}`,
        visibility: "public",
        status: "draft",
      });

      const byShortName = await skills.findInstallableSkillsByName({
        ...stranger,
        name,
      });
      expect(byShortName.map((row) => row.definition.slug)).toEqual([
        `gh-one-${tag}-${name}`,
        `gh-two-${tag}-${name}`,
      ]);
      const exact = await skills.findInstallableSkillsByName({
        ...stranger,
        name: `gh-two-${tag}-${name}`,
      });
      expect(exact).toHaveLength(1);
    });

    test("who installed is kept when the skill is merely switched back on", async () => {
      const slug = `gh-fixture-${randomUUID().slice(0, 8)}-via`;
      const { skillId, versionId } = await seed({ slug, visibility: "public" });
      const base = {
        ...owner,
        skillId,
        skillVersionId: versionId,
        enabledBy: owner.userId,
      };
      const installed = await skills.upsertWorkspaceSkill({
        ...base,
        installedVia: "agent",
      });
      expect(installed.installedVia).toBe("agent");
      // Re-enabling passes no `installedVia` and must not rewrite it …
      expect((await skills.upsertWorkspaceSkill(base)).installedVia).toBe(
        "agent",
      );
      // … while a person installing it again does.
      expect(
        (await skills.upsertWorkspaceSkill({ ...base, installedVia: "user" }))
          .installedVia,
      ).toBe("user");
    });

    test("uninstalling takes back the grant that installing gave", async () => {
      const slug = `gh-fixture-${randomUUID().slice(0, 8)}-grant`;
      const { skillId, versionId } = await seed({
        slug,
        visibility: "restricted",
      });
      const installed = await skills.upsertWorkspaceSkill({
        ...owner,
        skillId,
        skillVersionId: versionId,
        enabledBy: owner.userId,
      });
      const grants = () =>
        data.db
          .select()
          .from(data.skillEntitlements)
          .where(
            and(
              eq(data.skillEntitlements.skillId, skillId),
              eq(data.skillEntitlements.workspaceId, owner.workspaceId),
            ),
          );
      expect(await grants()).toHaveLength(1);

      expect(
        await skills.deleteWorkspaceSkillRecord({
          ...owner,
          workspaceSkillId: installed.id,
        }),
      ).toBe(true);
      expect(await grants()).toEqual([]);
      // Deleting something that is not there reports so and touches nothing.
      expect(
        await skills.deleteWorkspaceSkillRecord({
          ...owner,
          workspaceSkillId: installed.id,
        }),
      ).toBe(false);
    });
  },
);
