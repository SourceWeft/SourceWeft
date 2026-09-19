import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, test, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { sha256 } from "../hash";

describe.skipIf(process.env.RUN_SKILL_DB_TESTS !== "1")(
  "registry real PostgreSQL lifecycle",
  () => {
    let data: typeof import("@sourceweft/db");
    let repo: typeof import("./repository");
    let versions: typeof import("./versions");
    let review: typeof import("./review");
    let skills: typeof import("../repository");
    let selection: typeof import("../selection");
    const teamId = `skill-team-${randomUUID()}`,
      workspaceId = `skill-ws-${randomUUID()}`;
    const viewer = { teamId, workspaceId, userId: "skill-owner" };
    const ids: string[] = [];
    beforeAll(async () => {
      if (
        !new URL(process.env.DATABASE_URL!).pathname.startsWith(
          "/sourceweft_skillv6_",
        )
      )
        throw new Error("Refusing non-isolated database");
      data = await import("@sourceweft/db");
      repo = await import("./repository");
      versions = await import("./versions");
      review = await import("./review");
      skills = await import("../repository");
      selection = await import("../selection");
      await data.db
        .insert(data.workspaces)
        .values({
          id: workspaceId,
          organizationId: teamId,
          name: "Skill tests",
          slug: randomUUID(),
        });
    });
    afterAll(async () => {
      if (!data) return;
      for (const id of ids)
        await data.db
          .delete(data.skillDefinitions)
          .where(eq(data.skillDefinitions.id, id));
      await data.db
        .delete(data.teamAuditLogs)
        .where(eq(data.teamAuditLogs.teamId, teamId));
      await data.db
        .delete(data.workspaces)
        .where(eq(data.workspaces.id, workspaceId));
      await data.closeDatabase();
    });
    function input(slug: string, marker: string, flagged = false) {
      const commitSha = marker.repeat(40),
        contentText = `---\nname: writer\ndescription: Version ${marker}\n---\nBody ${marker}\n`,
        hash = sha256(contentText);
      return {
        slug,
        submitterId: viewer.userId,
        displayName: "Writer",
        description: `Version ${marker}`,
        commitSha,
        storagePointer: `github:fixture/skills@${commitSha}#writer`,
        contentHash: hash,
        versionStatus: flagged ? ("draft" as const) : ("published" as const),
        outcome: flagged ? ("queued" as const) : ("indexed" as const),
        files: [
          {
            path: "SKILL.md",
            contentText,
            mimeType: "text/markdown",
            sizeBytes: Buffer.byteLength(contentText),
            contentHash: hash,
          },
        ],
        manifestJson: {
          slug,
          displayName: "Writer",
          description: `Version ${marker}`,
          version: commitSha.slice(0, 12),
          visibility: "restricted" as const,
          categories: [],
          registry: {
            identifier: "gh:fixture/skills/writer",
            sourceUrl: `https://github.com/fixture/skills/tree/${commitSha}/writer`,
            repoUrl: "https://github.com/fixture/skills",
            submittedBy: viewer.userId,
            capability: "prompt-only" as const,
            scan: {
              reviewRequired: flagged,
              flags: flagged ? ["test-review"] : [],
            },
            fileManifest: [
              {
                path: "SKILL.md",
                sha256: hash,
                sizeBytes: Buffer.byteLength(contentText),
                role: "model-readable" as const,
              },
            ],
          },
        },
      };
    }
    async function create() {
      const source = input(`gh-fixture-${randomUUID()}`, "a");
      const saved = await repo.upsertRegistrySkillIndex(source);
      ids.push(saved.skillId);
      return { source, saved };
    }
    test("same source is immutable, conflicts and revoked resubmissions fail", async () => {
      const { source, saved } = await create();
      const [before] = await data.db
        .select()
        .from(data.skillVersions)
        .where(eq(data.skillVersions.id, saved.skillVersionId));
      const repeat = await repo.upsertRegistrySkillIndex({
        ...source,
        description: "cannot overwrite",
      });
      const [after] = await data.db
        .select()
        .from(data.skillVersions)
        .where(eq(data.skillVersions.id, saved.skillVersionId));
      expect(repeat.skillVersionId).toBe(saved.skillVersionId);
      expect(after).toEqual(before);
      await expect(
        repo.upsertRegistrySkillIndex({
          ...source,
          files: [{ ...source.files[0]!, contentHash: "different" }],
        }),
      ).rejects.toMatchObject({ code: "REGISTRY_VERSION_CONFLICT" });
      await review.setRegistrySkillVersionStatus(
        saved.skillVersionId,
        "deprecated",
        { actorUserId: "skill-test-admin", reason: "revoke test" },
      );
      await expect(repo.upsertRegistrySkillIndex(source)).rejects.toMatchObject(
        { code: "REGISTRY_VERSION_UNAVAILABLE" },
      );
    });
    test("B publish does not move installed A; switching keeps config and disabled state", async () => {
      const { source, saved: a } = await create();
      const installed = await skills.upsertWorkspaceSkill({
        ...viewer,
        skillId: a.skillId,
        skillVersionId: a.skillVersionId,
        enabledBy: viewer.userId,
        enabled: false,
        configJson: { custom: "keep" },
      });
      const b = await repo.upsertRegistrySkillIndex(input(source.slug, "b"));
      let [row] = await data.db
        .select()
        .from(data.workspaceSkills)
        .where(eq(data.workspaceSkills.id, installed.id));
      expect(row!.skillVersionId).toBe(a.skillVersionId);
      await versions.switchRegistryVersion({
        ...viewer,
        workspaceSkillId: installed.id,
        skillVersionId: b.skillVersionId,
      });
      [row] = await data.db
        .select()
        .from(data.workspaceSkills)
        .where(eq(data.workspaceSkills.id, installed.id));
      expect(row).toMatchObject({
        skillVersionId: b.skillVersionId,
        enabled: false,
        configJson: { custom: "keep" },
      });
      await data.db
        .update(data.workspaceSkills)
        .set({ enabled: true })
        .where(eq(data.workspaceSkills.id, installed.id));
      const resolved = await selection.resolveSelectedSkills({
        ...viewer,
        skillIds: [installed.id],
      });
      expect(resolved[0]).toMatchObject({
        version: "b".repeat(12),
        skillVersionId: b.skillVersionId,
        description: "Version b",
      });
      expect(
        resolved[0]!.files.find((f) => f.path === "SKILL.md")!.contentText,
      ).toContain("Body b");
      await versions.switchRegistryVersion({
        ...viewer,
        workspaceSkillId: installed.id,
        skillVersionId: a.skillVersionId,
      });
      const [current] = await data.db
        .select()
        .from(data.skillVersions)
        .where(
          and(
            eq(data.skillVersions.skillId, a.skillId),
            eq(data.skillVersions.isCurrent, true),
          ),
        );
      expect(current!.id).toBe(b.skillVersionId);
    });
    test("draft/reject preserve current; visibility and history access remain separate", async () => {
      const { source, saved: a } = await create();
      const c = await repo.upsertRegistrySkillIndex(
        input(source.slug, "c", true),
      );
      const [definition] = await data.db
        .select()
        .from(data.skillDefinitions)
        .where(eq(data.skillDefinitions.id, a.skillId));
      expect(definition!.description).toBe("Version a");
      const stranger = {
        ...viewer,
        userId: "another",
        teamId: "other-team",
        workspaceId: "other-workspace",
      };
      await expect(
        versions.listRegistryVersions({
          ...stranger,
          catalogId: a.skillId,
          limit: 20,
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
      await review.setRegistryVisibility({
        skillId: a.skillId,
        visibility: "public",
        actorUserId: "skill-test-admin",
      });
      expect(
        (
          await versions.listRegistryVersions({
            ...stranger,
            catalogId: a.skillId,
            limit: 20,
          })
        ).items.map((v) => v.id),
      ).toEqual([a.skillVersionId]);
      await expect(
        versions.getRegistryVersionDetail({
          ...stranger,
          catalogId: a.skillId,
          versionId: c.skillVersionId,
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        review.setRegistrySkillVersionStatus(c.skillVersionId, "deprecated", {
          actorUserId: "skill-test-admin",
        }),
      ).rejects.toMatchObject({ code: "REVIEW_REASON_REQUIRED" });
      await review.setRegistrySkillVersionStatus(
        c.skillVersionId,
        "deprecated",
        { actorUserId: "skill-test-admin", reason: "Fix unsafe text" },
      );
      expect(
        (
          await versions.getRegistryVersionDetail({
            ...viewer,
            catalogId: a.skillId,
            versionId: c.skillVersionId,
          })
        ).version.moderation?.reason,
      ).toBe("Fix unsafe text");
    });
    test("concurrent initial writes serialize and cannot change owner", async () => {
      const source = input(`gh-race-${randomUUID()}`, "a");
      const results = await Promise.all([
        repo.upsertRegistrySkillIndex(source),
        repo.upsertRegistrySkillIndex(source),
      ]);
      ids.push(results[0]!.skillId);
      expect(results[0]!.skillVersionId).toBe(results[1]!.skillVersionId);
      await expect(
        repo.upsertRegistrySkillIndex({ ...source, submitterId: "attacker" }),
      ).rejects.toMatchObject({ code: "REGISTRY_SUBMISSION_CONFLICT" });
    });
    test("revoked installed version is refused instead of replaced", async () => {
      const { saved: a } = await create();
      const installed = await skills.upsertWorkspaceSkill({
        ...viewer,
        skillId: a.skillId,
        skillVersionId: a.skillVersionId,
        enabledBy: viewer.userId,
      });
      await review.setRegistrySkillVersionStatus(
        a.skillVersionId,
        "deprecated",
        { actorUserId: "skill-test-admin", reason: "Unavailable" },
      );
      await expect(
        selection.resolveSelectedSkills({
          ...viewer,
          skillIds: [installed.id],
        }),
      ).rejects.toMatchObject({ code: "SKILL_NOT_PUBLISHED" });
      await expect(
        versions.switchRegistryVersion({
          ...viewer,
          workspaceSkillId: installed.id,
          skillVersionId: a.skillVersionId,
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  },
);
