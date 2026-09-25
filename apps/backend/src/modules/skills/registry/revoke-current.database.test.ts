import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, test, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  loadSkillDatabase,
  skillDatabaseEnabled,
} from "../../../test/skill-database";
import { sha256 } from "../hash";

// PostgreSQL is real; the object store under `../storage` is a map.
const store = vi.hoisted(() => ({ objects: new Map<string, Buffer>() }));
vi.mock("../../sources/storage", async () =>
  (await import("../../../test/fake-content-storage")).fakeContentStorage(
    store,
  ),
);

/**
 * Revoking the current version must not take the skill out of the catalog while
 * older published versions exist: currency passes to the best one left, by the
 * same commit-date ordering that decides currency on the way in. Real
 * PostgreSQL, because the hand-over has to get past the partial unique index on
 * `is_current` inside one transaction.
 */
describe.skipIf(!skillDatabaseEnabled)(
  "revoking the current registry version promotes a successor (real PostgreSQL)",
  () => {
    let data: typeof import("@sourceweft/db");
    let repo: typeof import("./repository");
    let review: typeof import("./review");
    let skills: typeof import("../repository");
    const teamId = `skill-team-${randomUUID()}`,
      workspaceId = `skill-ws-${randomUUID()}`;
    const viewer = { teamId, workspaceId, userId: "skill-owner" };
    const ids = new Set<string>();
    const OLDEST = "2025-12-01T00:00:00.000Z";
    const OLDER = "2026-01-01T00:00:00.000Z";
    const NEWER = "2026-02-01T00:00:00.000Z";
    const NEWEST = "2026-03-01T00:00:00.000Z";
    const revoke = { actorUserId: "skill-test-admin", reason: "bad release" };

    beforeAll(async () => {
      data = await loadSkillDatabase();
      repo = await import("./repository");
      review = await import("./review");
      skills = await import("../repository");
      await data.db.insert(data.workspaces).values({
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
        .delete(data.workspaces)
        .where(eq(data.workspaces.id, workspaceId));
      await data.closeDatabase();
    });

    function input(
      slug: string,
      marker: string,
      options: { committedAt: string; flagged?: boolean },
    ) {
      const flagged = options.flagged ?? false;
      const commitSha = marker.repeat(40),
        contentText = `---\nname: writer\ndescription: Version ${marker}\n---\nBody ${marker}\n`,
        hash = sha256(contentText);
      return {
        slug,
        submitterId: "skill-owner",
        displayName: `Writer ${marker}`,
        description: `Version ${marker}`,
        commitSha,
        storagePointer: `github:fixture/skills@${commitSha}#writer`,
        versionStatus: flagged ? ("draft" as const) : ("published" as const),
        outcome: flagged ? ("queued" as const) : ("indexed" as const),
        files: [
          {
            path: "SKILL.md",
            bytes: Buffer.from(contentText),
            mimeType: "text/markdown",
          },
        ],
        manifestJson: {
          slug,
          displayName: `Writer ${marker}`,
          description: `Version ${marker}`,
          version: commitSha.slice(0, 12),
          visibility: "restricted" as const,
          categories: [],
          registry: {
            identifier: "gh:fixture/skills/writer",
            sourceUrl: `https://github.com/fixture/skills/tree/${commitSha}/writer`,
            repoUrl: "https://github.com/fixture/skills",
            submittedBy: "skill-owner",
            committedAt: options.committedAt,
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
    const newSlug = () => `gh-revoke-${randomUUID()}`;
    async function upsert(source: ReturnType<typeof input>) {
      const saved = await repo.upsertRegistrySkillIndex(source);
      ids.add(saved.skillId);
      return saved;
    }
    async function state(skillId: string) {
      const [definition] = await data.db
        .select()
        .from(data.skillDefinitions)
        .where(eq(data.skillDefinitions.id, skillId));
      const versions = await data.db
        .select()
        .from(data.skillVersions)
        .where(eq(data.skillVersions.skillId, skillId));
      return {
        definition: definition!,
        versions,
        byId: (id: string) => versions.find((v) => v.id === id)!,
        current: versions.filter((v) => v.isCurrent).map((v) => v.id),
      };
    }
    // The audit record's successor pointer is written but not yet part of the
    // `SkillManifestJson["registry"]["moderation"]` type.
    const promotedId = (version: {
      manifestJson: import("@sourceweft/db").SkillManifestJson;
    }) =>
      (
        version.manifestJson.registry?.moderation as
          { promotedSkillVersionId?: string } | undefined
      )?.promotedSkillVersionId;

    test("currency passes down the published versions by commit date", async () => {
      const slug = newSlug();
      // Stored out of commit order, and the oldest commit is NOT the oldest
      // write, so neither write order nor created_at alone yields the right
      // successor. (Every registry version is dated: ingest refuses the rest.)
      const b = await upsert(input(slug, "b", { committedAt: NEWER }));
      const a = await upsert(input(slug, "a", { committedAt: OLDER }));
      const legacy = await upsert(input(slug, "d", { committedAt: OLDEST }));
      const c = await upsert(input(slug, "c", { committedAt: NEWEST }));
      let after = await state(c.skillId);
      expect(after.versions.every((v) => v.status === "published")).toBe(true);
      expect(after.current).toEqual([c.skillVersionId]);

      const expected = [
        { revoked: c, successor: b, marker: "b" },
        { revoked: b, successor: a, marker: "a" },
        { revoked: a, successor: legacy, marker: "d" },
      ];
      for (const step of expected) {
        const result = await review.setRegistrySkillVersionStatus(
          step.revoked.skillVersionId,
          "deprecated",
          revoke,
        );
        expect(result).toEqual({
          skillVersionId: step.revoked.skillVersionId,
          status: "deprecated",
        });
        after = await state(c.skillId);
        expect(after.current).toEqual([step.successor.skillVersionId]);
        const revoked = after.byId(step.revoked.skillVersionId);
        expect(revoked).toMatchObject({
          status: "deprecated",
          isCurrent: false,
        });
        expect(revoked.manifestJson.registry?.moderation).toMatchObject({
          action: "revoke",
          reason: "bad release",
        });
        expect(promotedId(revoked)).toBe(step.successor.skillVersionId);
        // The successor is promoted as-is: still published, its own history
        // (publishedAt, moderation) untouched.
        const successor = after.byId(step.successor.skillVersionId);
        expect(successor.status).toBe("published");
        expect(successor.manifestJson.registry?.moderation).toBeUndefined();
        // The definition describes the version users now get.
        expect(after.definition.displayName).toBe(`Writer ${step.marker}`);
        expect(after.definition.description).toBe(`Version ${step.marker}`);
      }
    });

    test("revoking the current version clears verified and says so in the audit trail", async () => {
      const slug = newSlug();
      const older = await upsert(input(slug, "a", { committedAt: OLDER }));
      const newer = await upsert(input(slug, "b", { committedAt: NEWER }));
      await data.db
        .update(data.skillDefinitions)
        .set({ verified: true })
        .where(eq(data.skillDefinitions.id, newer.skillId));

      await review.setRegistrySkillVersionStatus(
        newer.skillVersionId,
        "deprecated",
        revoke,
      );

      expect((await state(newer.skillId)).definition.verified).toBe(false);
      const events = await data.db
        .select()
        .from(data.skillMarketEvents)
        .where(eq(data.skillMarketEvents.skillId, newer.skillId));
      expect(events).toEqual([
        expect.objectContaining({
          actorKind: "system",
          action: "verified.cleared",
          detail: {
            fromVersionId: newer.skillVersionId,
            toVersionId: older.skillVersionId,
          },
        }),
      ]);
    });

    test("versions of equal commit date rank among themselves by created_at, newest first", async () => {
      const slug = newSlug();
      const first = await upsert(input(slug, "a", { committedAt: OLDER }));
      const second = await upsert(input(slug, "b", { committedAt: OLDER }));
      const third = await upsert(input(slug, "c", { committedAt: OLDER }));
      // Pin created_at so the order under test cannot hinge on the clock, and
      // does not coincide with the order the rows were written in.
      for (const [saved, createdAt] of [
        [first, "2026-05-02T00:00:00.000Z"],
        [second, "2026-05-01T00:00:00.000Z"],
        [third, "2026-05-03T00:00:00.000Z"],
      ] as const)
        await data.db
          .update(data.skillVersions)
          .set({ createdAt: new Date(createdAt) })
          .where(eq(data.skillVersions.id, saved.skillVersionId));
      expect((await state(first.skillId)).current).toEqual([
        third.skillVersionId,
      ]);

      await review.setRegistrySkillVersionStatus(
        third.skillVersionId,
        "deprecated",
        revoke,
      );
      const after = await state(first.skillId);
      expect(after.current).toEqual([first.skillVersionId]);
      expect(after.definition.description).toBe("Version a");
    });

    test("revoking a NON-current version changes nothing about currency", async () => {
      const slug = newSlug();
      const older = await upsert(input(slug, "a", { committedAt: OLDER }));
      const newer = await upsert(input(slug, "b", { committedAt: NEWER }));
      const before = await state(newer.skillId);
      expect(before.current).toEqual([newer.skillVersionId]);

      await review.setRegistrySkillVersionStatus(
        older.skillVersionId,
        "deprecated",
        revoke,
      );
      const after = await state(newer.skillId);
      expect(after.current).toEqual([newer.skillVersionId]);
      expect(after.byId(older.skillVersionId).status).toBe("deprecated");
      expect(promotedId(after.byId(older.skillVersionId))).toBeUndefined();
      // The current version's row and the definition's display fields are not
      // rewritten.
      expect(after.byId(newer.skillVersionId)).toEqual(
        before.byId(newer.skillVersionId),
      );
      expect(after.definition.displayName).toBe("Writer b");
      expect(after.definition.description).toBe("Version b");
    });

    test("revoking the only published version leaves the skill with no current version", async () => {
      const slug = newSlug();
      const only = await upsert(input(slug, "a", { committedAt: OLDER }));
      await review.setRegistrySkillVersionStatus(
        only.skillVersionId,
        "deprecated",
        revoke,
      );
      const after = await state(only.skillId);
      expect(after.current).toEqual([]);
      expect(after.byId(only.skillVersionId).status).toBe("deprecated");
      expect(promotedId(after.byId(only.skillVersionId))).toBeUndefined();
      // Nothing to describe instead, so the display fields stay as they were.
      expect(after.definition.description).toBe("Version a");
    });

    test("a draft is never promoted, however new its commit", async () => {
      const slug = newSlug();
      const published = await upsert(input(slug, "a", { committedAt: OLDER }));
      const current = await upsert(input(slug, "b", { committedAt: NEWER }));
      const draft = await upsert(
        input(slug, "c", { committedAt: NEWEST, flagged: true }),
      );
      expect(draft.status).toBe("queued");

      await review.setRegistrySkillVersionStatus(
        current.skillVersionId,
        "deprecated",
        revoke,
      );
      let after = await state(current.skillId);
      expect(after.current).toEqual([published.skillVersionId]);
      expect(after.byId(draft.skillVersionId)).toMatchObject({
        status: "draft",
        isCurrent: false,
      });

      // With only a draft left, nothing is promoted at all.
      await review.setRegistrySkillVersionStatus(
        published.skillVersionId,
        "deprecated",
        revoke,
      );
      after = await state(current.skillId);
      expect(after.current).toEqual([]);
      expect(after.byId(draft.skillVersionId)).toMatchObject({
        status: "draft",
        isCurrent: false,
      });
      // Rejecting that draft is not a revocation of a current version either.
      await review.setRegistrySkillVersionStatus(
        draft.skillVersionId,
        "deprecated",
        revoke,
      );
      after = await state(current.skillId);
      expect(after.current).toEqual([]);
      expect(
        after.byId(draft.skillVersionId).manifestJson.registry?.moderation
          ?.action,
      ).toBe("reject");
    });

    test("a workspace pinned to the revoked version keeps its pin", async () => {
      const slug = newSlug();
      const older = await upsert(input(slug, "a", { committedAt: OLDER }));
      const newer = await upsert(input(slug, "b", { committedAt: NEWER }));
      const installed = await skills.upsertWorkspaceSkill({
        ...viewer,
        skillId: newer.skillId,
        skillVersionId: newer.skillVersionId,
        enabledBy: viewer.userId,
        enabled: true,
        configJson: { custom: "keep" },
      });
      const [before] = await data.db
        .select()
        .from(data.workspaceSkills)
        .where(eq(data.workspaceSkills.id, installed.id));

      await review.setRegistrySkillVersionStatus(
        newer.skillVersionId,
        "deprecated",
        revoke,
      );
      expect((await state(newer.skillId)).current).toEqual([
        older.skillVersionId,
      ]);
      const [row] = await data.db
        .select()
        .from(data.workspaceSkills)
        .where(eq(data.workspaceSkills.id, installed.id));
      // Promotion is a catalog fact; moving an install is the workspace's call.
      expect(row).toEqual(before);
      expect(row!.skillVersionId).toBe(newer.skillVersionId);
    });
  },
);
