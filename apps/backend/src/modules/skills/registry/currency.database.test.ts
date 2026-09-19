import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, test, expect } from "vitest";
import { asc, eq } from "drizzle-orm";
import { sha256 } from "../hash";

/**
 * Which version is current is decided by the pinned commit's committer date,
 * not by which transaction or which admin action happened last. Real
 * PostgreSQL, because the property under test is what the advisory lock and
 * the partial unique index on `is_current` actually let through.
 */
describe.skipIf(process.env.RUN_SKILL_DB_TESTS !== "1")(
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
      if (
        !new URL(process.env.DATABASE_URL!).pathname.startsWith(
          "/sourceweft_skillv6_",
        )
      )
        throw new Error("Refusing non-isolated database");
      data = await import("@sourceweft/db");
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
      options: { committedAt?: string; flagged?: boolean } = {},
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

      const result = await review.setRegistrySkillVersionStatus(
        draft.skillVersionId,
        "published",
        { ...admin, visibility: "public" },
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
      // Display fields stay with the current version; the admin's visibility
      // decision is about the skill and still applies.
      expect(after.definition.displayName).toBe("Writer b");
      expect(after.definition.description).toBe("Version b");
      expect(after.definition.visibility).toBe("public");
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

    test("legacy versions without committedAt keep newest-write-wins", async () => {
      const slug = newSlug();
      const first = await upsert(input(slug, "a"));
      const second = await upsert(input(slug, "b"));
      let after = await state(first.skillId);
      expect(after.current).toEqual([second.skillVersionId]);
      expect(after.definition.description).toBe("Version b");

      // Admin publish between two undated versions behaves as it always did.
      const draft = await upsert(input(slug, "c", { flagged: true }));
      await review.setRegistrySkillVersionStatus(
        draft.skillVersionId,
        "published",
        admin,
      );
      after = await state(first.skillId);
      expect(after.current).toEqual([draft.skillVersionId]);
      expect(after.definition.description).toBe("Version c");
    });

    test("a dated commit outranks an undated current version, and not the reverse", async () => {
      const slug = newSlug();
      const legacy = await upsert(input(slug, "a"));
      const dated = await upsert(input(slug, "b", { committedAt: OLDER }));
      let after = await state(legacy.skillId);
      expect(after.current).toEqual([dated.skillVersionId]);

      // Unknown date ranks as oldest once the current version has one.
      const undated = await upsert(input(slug, "c"));
      after = await state(legacy.skillId);
      expect(after.current).toEqual([dated.skillVersionId]);
      expect(
        after.versions.find((v) => v.id === undated.skillVersionId),
      ).toMatchObject({ status: "published", isCurrent: false });
      expect(after.definition.description).toBe("Version b");
    });
  },
);
