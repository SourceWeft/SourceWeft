import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, test, expect, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { sha256 } from "../hash";
import {
  loadSkillDatabase,
  skillDatabaseEnabled,
} from "../../../test/skill-database";

// PostgreSQL is real; the object store under `../storage` is a map.
const store = vi.hoisted(() => ({ objects: new Map<string, Buffer>() }));
vi.mock("../../sources/storage", async () =>
  (await import("../../../test/fake-content-storage")).fakeContentStorage(
    store,
  ),
);

/**
 * Which version is current is decided by the pinned commit's committer date,
 * not by which transaction or which admin action happened last. Real
 * PostgreSQL, because the property under test is what the advisory lock and
 * the partial unique index on `is_current` actually let through.
 */
describe.skipIf(!skillDatabaseEnabled)(
  "registry current version follows commit date (real PostgreSQL)",
  () => {
    let data: typeof import("@sourceweft/db");
    let repo: typeof import("./repository");
    let review: typeof import("./review");
    const ids = new Set<string>();
    const OLDER = "2026-01-01T00:00:00.000Z";
    const NEWER = "2026-02-01T00:00:00.000Z";
    const admin = { actorUserId: "skill-test-admin" };

    beforeAll(async () => {
      data = await loadSkillDatabase();
      repo = await import("./repository");
      review = await import("./review");
    });
    afterAll(async () => {
      if (!data) return;
      for (const id of ids)
        await data.db
          .delete(data.skillDefinitions)
          .where(eq(data.skillDefinitions.id, id));
      await data.closeDatabase();
    });

    function input(
      slug: string,
      marker: string,
      options: { committedAt?: string; flagged?: boolean },
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
            ...(options.committedAt
              ? { committedAt: options.committedAt }
              : {}),
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
    const newSlug = () => `gh-currency-${randomUUID()}`;
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
        .where(eq(data.skillVersions.skillId, skillId))
        .orderBy(asc(data.skillVersions.version));
      return {
        definition: definition!,
        versions,
        current: versions.filter((v) => v.isCurrent).map((v) => v.id),
      };
    }

    test("an OLDER commit submitted after a newer one is stored as history, not current", async () => {
      const slug = newSlug();
      const newer = await upsert(input(slug, "b", { committedAt: NEWER }));
      const older = await upsert(input(slug, "a", { committedAt: OLDER }));
      expect(older.status).toBe("indexed");

      const after = await state(newer.skillId);
      expect(after.current).toEqual([newer.skillVersionId]);
      const stored = after.versions.find((v) => v.id === older.skillVersionId)!;
      // Published and listable as a historical version — just not current.
      expect(stored.status).toBe("published");
      expect(stored.isCurrent).toBe(false);
      expect(stored.publishedAt).toBeInstanceOf(Date);
      // The definition keeps describing the version users actually get.
      expect(after.definition.displayName).toBe("Writer b");
      expect(after.definition.description).toBe("Version b");
    });

    test("a NEWER commit submitted after an older one takes over and syncs display fields", async () => {
      const slug = newSlug();
      const older = await upsert(input(slug, "a", { committedAt: OLDER }));
      const newer = await upsert(input(slug, "b", { committedAt: NEWER }));
      const after = await state(older.skillId);
      expect(after.current).toEqual([newer.skillVersionId]);
      expect(after.definition.displayName).toBe("Writer b");
      expect(after.definition.description).toBe("Version b");
    });

    test("concurrent upserts of two commits end with the newer commit current, in either order", async () => {
      // Which transaction wins the advisory lock is not controllable, so each
      // argument order is raced several times; every run must agree.
      for (let round = 0; round < 6; round += 1) {
        const slug = newSlug();
        const older = input(slug, "a", { committedAt: OLDER });
        const newer = input(slug, "b", { committedAt: NEWER });
        const pair = round % 2 === 0 ? [older, newer] : [newer, older];
        const results = await Promise.all(
          pair.map((source) => repo.upsertRegistrySkillIndex(source)),
        );
        ids.add(results[0]!.skillId);
        expect(results[0]!.skillId).toBe(results[1]!.skillId);
        const newerResult = results[pair.indexOf(newer)]!;

        const after = await state(newerResult.skillId);
        expect(after.versions).toHaveLength(2);
        expect(after.versions.every((v) => v.status === "published")).toBe(
          true,
        );
        expect(after.current).toEqual([newerResult.skillVersionId]);
        expect(after.definition.description).toBe("Version b");
      }
    });

    test("concurrent upserts onto an existing skill also settle on the newest commit", async () => {
      const slug = newSlug();
      const base = await upsert(input(slug, "a", { committedAt: OLDER }));
      const middle = input(slug, "b", { committedAt: NEWER });
      const newest = input(slug, "c", {
        committedAt: "2026-03-01T00:00:00.000Z",
      });
      const [, newestResult] = await Promise.all([
        repo.upsertRegistrySkillIndex(middle),
        repo.upsertRegistrySkillIndex(newest),
      ]);
      const after = await state(base.skillId);
      expect(after.versions).toHaveLength(3);
      expect(after.current).toEqual([newestResult!.skillVersionId]);
      expect(after.definition.description).toBe("Version c");
    });

    test("an admin publishing an OLDER draft after a newer published version does not roll back", async () => {
      const slug = newSlug();
      const newer = await upsert(input(slug, "b", { committedAt: NEWER }));
      const draft = await upsert(
        input(slug, "a", { committedAt: OLDER, flagged: true }),
      );
      expect(draft.status).toBe("queued");

      // "Make public" is refused from a version nobody would get: what goes
      // public is the current one, which is not what is being reviewed here.
      await expect(
        review.setRegistrySkillVersionStatus(
          draft.skillVersionId,
          "published",
          {
            ...admin,
            visibility: "public",
          },
        ),
      ).rejects.toMatchObject({ code: "SKILL_VISIBILITY_NOT_CURRENT" });
      const untouched = await state(newer.skillId);
      expect(untouched.definition.visibility).toBe("restricted");
      expect(
        untouched.versions.find((v) => v.id === draft.skillVersionId)!.status,
      ).toBe("draft");

      const result = await review.setRegistrySkillVersionStatus(
        draft.skillVersionId,
        "published",
        admin,
      );
      expect(result).toEqual({
        skillVersionId: draft.skillVersionId,
        status: "published",
      });

      const after = await state(newer.skillId);
      expect(after.current).toEqual([newer.skillVersionId]);
      const approved = after.versions.find(
        (v) => v.id === draft.skillVersionId,
      )!;
      expect(approved.status).toBe("published");
      expect(approved.isCurrent).toBe(false);
      expect(approved.publishedAt).toBeInstanceOf(Date);
      expect(approved.manifestJson.registry?.moderation?.action).toBe(
        "publish",
      );
      // Display fields stay with the current version.
      expect(after.definition.displayName).toBe("Writer b");
      expect(after.definition.description).toBe("Version b");
      expect(after.definition.visibility).toBe("restricted");
    });

    test("an admin publishing a NEWER draft still promotes it", async () => {
      const slug = newSlug();
      const older = await upsert(input(slug, "a", { committedAt: OLDER }));
      const draft = await upsert(
        input(slug, "b", { committedAt: NEWER, flagged: true }),
      );
      let after = await state(older.skillId);
      expect(after.current).toEqual([older.skillVersionId]);

      await review.setRegistrySkillVersionStatus(
        draft.skillVersionId,
        "published",
        admin,
      );
      after = await state(older.skillId);
      expect(after.current).toEqual([draft.skillVersionId]);
      expect(after.definition.description).toBe("Version b");
    });

    test("a version without a commit date is refused, and stores nothing", async () => {
      // Currency is decided by commit age alone, so an undated version has no
      // place in the order — ingest fails rather than invent one.
      const slug = newSlug();
      const dated = await upsert(input(slug, "a", { committedAt: OLDER }));
      await expect(
        repo.upsertRegistrySkillIndex(input(slug, "b", {})),
      ).rejects.toMatchObject({ code: "REGISTRY_SUBMISSION_UNDATED" });
      const after = await state(dated.skillId);
      expect(after.versions.map((v) => v.id)).toEqual([dated.skillVersionId]);
      expect(after.current).toEqual([dated.skillVersionId]);
    });
  },
);
