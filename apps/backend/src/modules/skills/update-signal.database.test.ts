import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import {
  loadSkillDatabase,
  seedSkillDefinition,
  skillDatabaseEnabled,
} from "../../test/skill-database";

// "Update available" is a join in the installed-skills query — which version is
// current, and whether it is published, is only provable against PostgreSQL.
describe.skipIf(!skillDatabaseEnabled)(
  "installed skill update signal against real PostgreSQL",
  () => {
    let data: typeof import("@sourceweft/db");
    let skills: typeof import("./repository");
    const scope = {
      teamId: `skill-team-${randomUUID()}`,
      workspaceId: `skill-ws-${randomUUID()}`,
    };
    const definitionIds: string[] = [];

    async function seedDefinition(slug: string) {
      const skillId = await seedSkillDefinition(data, {
        slug,
        ownerUserId: "update-signal-owner",
      });
      definitionIds.push(skillId);
      return skillId;
    }

    async function seedVersion(input: {
      skillId: string;
      slug: string;
      version: string;
      status: "published" | "draft";
      isCurrent: boolean;
    }) {
      const versionId = randomUUID();
      await data.db.insert(data.skillVersions).values({
        id: versionId,
        skillId: input.skillId,
        version: input.version,
        status: input.status,
        storageType: "object",
        skillMd: "---\nname: fixture\ndescription: fixture\n---\n",
        bundleSha256: "0".repeat(64),
        bundleObjectKey: `skills/bundles/${"0".repeat(64)}.zip`,
        bundleSizeBytes: 1,
        storagePointer: `github:fixture/skills@${input.version}#x`,
        isCurrent: input.isCurrent,
        contentHash: "hash",
        manifestJson: {
          slug: input.slug,
          displayName: input.slug,
          version: input.version,
          description: "fixture",
          visibility: "public",
          categories: [],
        },
      });
      return versionId;
    }

    async function install(skillId: string, skillVersionId: string) {
      await data.db.insert(data.workspaceSkills).values({
        id: randomUUID(),
        teamId: scope.teamId,
        workspaceId: scope.workspaceId,
        skillId,
        skillVersionId,
        enabled: true,
      });
    }

    async function installedBySlug(slug: string) {
      const items = await skills.listWorkspaceInstalledSkills(scope);
      const matches = items.filter((item) => item.slug === slug);
      // One install, one row: the current-version join must not multiply it.
      expect(matches).toHaveLength(1);
      return matches[0]!;
    }

    beforeAll(async () => {
      data = await loadSkillDatabase();
      skills = await import("./repository");
      await data.db.insert(data.workspaces).values({
        id: scope.workspaceId,
        organizationId: scope.teamId,
        name: "Update signal tests",
        slug: randomUUID(),
      });
    });

    afterAll(async () => {
      if (!data) return;
      // Versions and installs cascade from the definition and the workspace.
      for (const id of definitionIds)
        await data.db
          .delete(data.skillDefinitions)
          .where(eq(data.skillDefinitions.id, id));
      await data.db
        .delete(data.workspaces)
        .where(eq(data.workspaces.id, scope.workspaceId));
      await data.closeDatabase();
    });

    test("an install on the current version is up to date", async () => {
      const slug = `gh-fixture-${randomUUID().slice(0, 8)}-fresh`;
      const skillId = await seedDefinition(slug);
      const current = await seedVersion({
        skillId,
        slug,
        version: "a".repeat(12),
        status: "published",
        isCurrent: true,
      });
      await install(skillId, current);

      const item = await installedBySlug(slug);
      expect(item.skillVersionId).toBe(current);
      expect(item.currentVersionId).toBe(current);
      expect(item.updateAvailable).toBe(false);
    });

    test("an install pinned behind the published current version has an update", async () => {
      const slug = `gh-fixture-${randomUUID().slice(0, 8)}-behind`;
      const skillId = await seedDefinition(slug);
      const pinned = await seedVersion({
        skillId,
        slug,
        version: "a".repeat(12),
        status: "published",
        isCurrent: false,
      });
      const current = await seedVersion({
        skillId,
        slug,
        version: "b".repeat(12),
        status: "published",
        isCurrent: true,
      });
      await install(skillId, pinned);

      const item = await installedBySlug(slug);
      // Still describes what is installed, not what is current.
      expect(item.skillVersionId).toBe(pinned);
      expect(item.version).toBe("a".repeat(12));
      expect(item.currentVersionId).toBe(current);
      expect(item.updateAvailable).toBe(true);
    });

    test("a current version still under review is not an update", async () => {
      const slug = `gh-fixture-${randomUUID().slice(0, 8)}-held`;
      const skillId = await seedDefinition(slug);
      const pinned = await seedVersion({
        skillId,
        slug,
        version: "a".repeat(12),
        status: "published",
        isCurrent: false,
      });
      await seedVersion({
        skillId,
        slug,
        version: "b".repeat(12),
        status: "draft",
        isCurrent: true,
      });
      await install(skillId, pinned);

      const item = await installedBySlug(slug);
      expect(item.currentVersionId).toBeNull();
      expect(item.updateAvailable).toBe(false);
    });

    test("a skill with no current version at all is not an update", async () => {
      const slug = `gh-fixture-${randomUUID().slice(0, 8)}-nocurrent`;
      const skillId = await seedDefinition(slug);
      const pinned = await seedVersion({
        skillId,
        slug,
        version: "a".repeat(12),
        status: "published",
        isCurrent: false,
      });
      await install(skillId, pinned);

      const item = await installedBySlug(slug);
      expect(item.currentVersionId).toBeNull();
      expect(item.updateAvailable).toBe(false);
    });
  },
);
