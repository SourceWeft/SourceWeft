import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";

// Grant scope and the escalation gate are both decided by SQL over real rows
// (nullable columns, `now()`, jsonb manifests), so only PostgreSQL can prove
// that one workspace's install stays in that workspace.
describe.skipIf(process.env.RUN_SKILL_DB_TESTS !== "1")(
  "entitlement scope and version escalation against real PostgreSQL",
  () => {
    let data: typeof import("@sourceweft/db");
    let skills: typeof import("./repository");
    let versions: typeof import("./registry/versions");
    const teamId = `skill-team-${randomUUID()}`;
    // Nobody here owns the fixtures: the submitter's own view would mask a leak.
    const userId = "scope-member";
    const a = { teamId, workspaceId: `skill-ws-${randomUUID()}`, userId };
    const b = { teamId, workspaceId: `skill-ws-${randomUUID()}`, userId };
    const outsider = {
      teamId: `skill-team-${randomUUID()}`,
      workspaceId: `skill-ws-${randomUUID()}`,
      userId,
    };
    const definitionIds: string[] = [];

    type Capability = "prompt-only" | "executable";
    async function seedDefinition() {
      const skillId = randomUUID();
      const slug = `gh-fixture-${randomUUID().slice(0, 8)}-scope`;
      definitionIds.push(skillId);
      await data.db.insert(data.skillDefinitions).values({
        id: skillId,
        sourceType: "registry_github",
        slug,
        displayName: slug,
        description: "fixture",
        visibility: "restricted",
        status: "active",
        ownerUserId: "scope-owner",
      });
      return { skillId, slug };
    }
    async function seedVersion(input: {
      skillId: string;
      slug: string;
      marker: string;
      isCurrent: boolean;
      capability?: Capability;
      flags?: string[];
    }) {
      const versionId = randomUUID();
      const version = input.marker.repeat(12);
      await data.db.insert(data.skillVersions).values({
        id: versionId,
        skillId: input.skillId,
        version,
        status: "published",
        storageType: "db_text",
        storagePointer: `github:fixture/skills@${input.marker.repeat(40)}#scope`,
        isCurrent: input.isCurrent,
        contentHash: `hash-${input.marker}`,
        manifestJson: {
          slug: input.slug,
          displayName: input.slug,
          version,
          description: "fixture",
          visibility: "restricted",
          categories: [],
          registry: {
            identifier: "gh:fixture/skills/scope",
            sourceUrl: "https://github.com/fixture/skills",
            repoUrl: "https://github.com/fixture/skills",
            submittedBy: "scope-owner",
            capability: input.capability ?? "prompt-only",
            scan: { reviewRequired: false, flags: input.flags ?? [] },
            fileManifest: [],
          },
        },
      });
      return versionId;
    }
    async function seed() {
      const definition = await seedDefinition();
      const versionId = await seedVersion({
        ...definition,
        marker: "a",
        isCurrent: true,
      });
      return { ...definition, versionId };
    }
    async function visibleTo(
      scope: typeof a,
      skill: { skillId: string; slug: string },
    ) {
      const byName = await skills.findInstallableSkillsByName({
        ...scope,
        name: skill.slug,
      });
      const catalog = await skills.listCatalogSkillVersionsForWorkspace(scope);
      return {
        byName: byName.some((row) => row.definition.id === skill.skillId),
        catalog: catalog.some((row) => row.definition.id === skill.skillId),
      };
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
      versions = await import("./registry/versions");
      for (const scope of [a, b, outsider])
        await data.db.insert(data.workspaces).values({
          id: scope.workspaceId,
          organizationId: scope.teamId,
          name: "Entitlement scope tests",
          slug: randomUUID(),
        });
    });
    afterAll(async () => {
      if (!data) return;
      // Definitions cascade to their versions, installs and grants.
      for (const id of definitionIds)
        await data.db
          .delete(data.skillDefinitions)
          .where(eq(data.skillDefinitions.id, id));
      await data.db
        .delete(data.teamAuditLogs)
        .where(eq(data.teamAuditLogs.teamId, teamId));
      for (const scope of [a, b, outsider])
        await data.db
          .delete(data.workspaces)
          .where(eq(data.workspaces.id, scope.workspaceId));
      await data.closeDatabase();
    });

    test("an install grants the installing workspace, not its team", async () => {
      const skill = await seed();
      const installed = await skills.upsertWorkspaceSkill({
        ...a,
        skillId: skill.skillId,
        skillVersionId: skill.versionId,
        enabledBy: userId,
      });

      expect(await visibleTo(b, skill)).toEqual({
        byName: false,
        catalog: false,
      });
      expect(
        await skills.loadSkillVersionBundle({
          ...b,
          skillId: skill.skillId,
          skillVersionId: skill.versionId,
        }),
      ).toBeNull();
      await expect(
        versions.listRegistryVersions({
          ...b,
          catalogId: skill.skillId,
          limit: 20,
        }),
      ).rejects.toMatchObject({ statusCode: 404 });

      // The installing workspace keeps everything the grant exists for.
      expect(await visibleTo(a, skill)).toEqual({
        byName: true,
        catalog: true,
      });
      expect(
        (
          await skills.loadSkillVersionBundle({
            ...a,
            skillId: skill.skillId,
            skillVersionId: skill.versionId,
          })
        )?.version.id,
      ).toBe(skill.versionId);
      expect(
        (await skills.listEnabledWorkspaceSkillRecords(a)).map((row) => row.id),
      ).toContain(installed.id);
      expect(
        (
          await versions.listRegistryVersions({
            ...a,
            catalogId: skill.skillId,
            limit: 20,
          })
        ).items.map((v) => v.id),
      ).toEqual([skill.versionId]);
    });

    test("a grant without a workspace reaches every workspace of its team only", async () => {
      const skill = await seed();
      await data.db.insert(data.skillEntitlements).values({
        id: randomUUID(),
        skillId: skill.skillId,
        teamId,
        workspaceId: null,
        grantedBy: "scope-admin",
      });
      for (const scope of [a, b])
        expect(await visibleTo(scope, skill)).toEqual({
          byName: true,
          catalog: true,
        });
      expect(await visibleTo(outsider, skill)).toEqual({
        byName: false,
        catalog: false,
      });
      expect(
        (
          await versions.listRegistryVersions({
            ...b,
            catalogId: skill.skillId,
            limit: 20,
          })
        ).items,
      ).toHaveLength(1);
    });

    test("expired grants and blank ids grant nothing", async () => {
      const skill = await seed();
      const past = new Date(Date.now() - 60_000);
      await data.db.insert(data.skillEntitlements).values([
        {
          id: randomUUID(),
          skillId: skill.skillId,
          teamId,
          workspaceId: null,
          expiresAt: past,
        },
        {
          id: randomUUID(),
          skillId: skill.skillId,
          teamId,
          workspaceId: b.workspaceId,
          expiresAt: past,
        },
        // `team_id` has no foreign key, so a blank row is possible; the admin
        // route reads with blank ids and must not be matched by it.
        { id: randomUUID(), skillId: skill.skillId, teamId: "" },
      ]);
      expect(await visibleTo(b, skill)).toEqual({
        byName: false,
        catalog: false,
      });
      await expect(
        versions.getRegistryVersionDetail({
          userId,
          teamId: "",
          workspaceId: "",
          catalogId: skill.skillId,
          versionId: skill.versionId,
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    test("switching to a version that gains scripts or flags needs acknowledgement", async () => {
      const skill = await seed();
      const executable = await seedVersion({
        ...skill,
        marker: "b",
        isCurrent: false,
        capability: "executable",
      });
      const flagged = await seedVersion({
        ...skill,
        marker: "c",
        isCurrent: false,
        capability: "executable",
        flags: ["network-access"],
      });
      const installed = await skills.upsertWorkspaceSkill({
        ...a,
        skillId: skill.skillId,
        skillVersionId: skill.versionId,
        enabledBy: userId,
      });
      const pinned = async () =>
        (
          await data.db
            .select()
            .from(data.workspaceSkills)
            .where(eq(data.workspaceSkills.id, installed.id))
        )[0]!.skillVersionId;
      const switchTo = (skillVersionId: string, acknowledgeEscalation?: true) =>
        versions.switchRegistryVersion({
          ...a,
          workspaceSkillId: installed.id,
          skillVersionId,
          acknowledgeEscalation,
        });

      await expect(switchTo(executable)).rejects.toMatchObject({
        statusCode: 409,
        code: "SKILL_VERSION_ESCALATION",
        details: { addsScripts: true, newFlags: [] },
      });
      expect(await pinned()).toBe(skill.versionId);
      await switchTo(executable, true);
      expect(await pinned()).toBe(executable);

      // Same capability, but a flag this workspace has never accepted.
      await expect(switchTo(flagged)).rejects.toMatchObject({
        code: "SKILL_VERSION_ESCALATION",
        details: { addsScripts: false, newFlags: ["network-access"] },
      });
      await switchTo(flagged, true);
      expect(await pinned()).toBe(flagged);

      // Losing flags, losing scripts and standing still are never escalations.
      await switchTo(executable);
      expect(await pinned()).toBe(executable);
      await switchTo(executable);
      await switchTo(skill.versionId);
      expect(await pinned()).toBe(skill.versionId);
    });
  },
);
