import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { sha256 } from "../hash";

// PostgreSQL is real; object storage is a map in which a missing key fails the
// way S3 does, so the cache-miss path is the one under test.
const store = vi.hoisted(() => ({ objects: new Map<string, Buffer>() }));
vi.mock("../../sources/storage", () => ({
  getContentStorageBucketName: () => "bucket",
  sandboxAssetObjectExists: async ({ key }: { key: string }) =>
    store.objects.has(key),
  uploadFileObject: async (input: { key: string; body: Buffer }) => {
    store.objects.set(input.key, input.body);
    return { bucket: "bucket", key: input.key };
  },
  downloadFileObject: async ({ key }: { key: string }) => {
    const body = store.objects.get(key);
    if (!body) throw Object.assign(new Error("gone"), { name: "NoSuchKey" });
    return body;
  },
}));

/**
 * Object storage is a cache of a community skill: what is lost can be fetched
 * again from the pinned commit, and is only written back when every file hashes
 * to what ingest recorded.
 */
describe.skipIf(process.env.RUN_SKILL_DB_TESTS !== "1")(
  "restoring a skill version from its source (real PostgreSQL)",
  () => {
    let data: typeof import("@sourceweft/db");
    let repo: typeof import("../registry/repository");
    let restore: typeof import("./restore");
    const ids = new Set<string>();
    const commitSha = "c".repeat(40);
    const skillMd = `---\nname: restorable\ndescription: Restorable\n---\nBody\n`;
    const script = "print('hello')\n";

    beforeAll(async () => {
      if (
        !new URL(process.env.DATABASE_URL!).pathname.startsWith(
          "/sourceweft_skillv6_",
        )
      )
        throw new Error("Refusing non-isolated database");
      data = await import("@sourceweft/db");
      repo = await import("../registry/repository");
      restore = await import("./restore");
    });
    afterAll(async () => {
      if (!data) return;
      for (const id of ids)
        await data.db
          .delete(data.skillDefinitions)
          .where(eq(data.skillDefinitions.id, id));
      await data.closeDatabase();
    });

    async function registrySkill() {
      const slug = `gh-restore-${randomUUID()}`;
      const saved = await repo.upsertRegistrySkillIndex({
        slug,
        submitterId: "skill-owner",
        displayName: "Restorable",
        description: "Restorable",
        commitSha,
        storagePointer: `github:fixture/skills@${commitSha}#skills/restorable`,
        versionStatus: "published",
        outcome: "indexed",
        files: [
          {
            path: "SKILL.md",
            bytes: Buffer.from(skillMd),
            mimeType: "text/markdown",
          },
          {
            path: "scripts/run.py",
            bytes: Buffer.from(script),
            mimeType: "text/x-python",
          },
        ],
        manifestJson: {
          slug,
          displayName: "Restorable",
          description: "Restorable",
          version: commitSha.slice(0, 12),
          visibility: "restricted",
          categories: [],
          registry: {
            identifier: `gh:fixture/skills/${slug}`,
            sourceUrl: `https://github.com/fixture/skills/tree/${commitSha}/skills/restorable`,
            repoUrl: "https://github.com/fixture/skills",
            submittedBy: "skill-owner",
            committedAt: "2026-01-01T00:00:00.000Z",
            capability: "executable",
            scan: { reviewRequired: false, flags: [] },
            fileManifest: [
              {
                path: "SKILL.md",
                sha256: sha256(skillMd),
                sizeBytes: Buffer.byteLength(skillMd),
                role: "model-readable",
              },
              {
                path: "scripts/run.py",
                sha256: sha256(script),
                sizeBytes: Buffer.byteLength(script),
                role: "script",
              },
            ],
          },
        },
      });
      ids.add(saved.skillId);
      const rows = await data.db
        .select()
        .from(data.skillVersionFiles)
        .where(eq(data.skillVersionFiles.skillVersionId, saved.skillVersionId));
      const [version] = await data.db
        .select()
        .from(data.skillVersions)
        .where(eq(data.skillVersions.id, saved.skillVersionId));
      return { ...saved, rows, version: version! };
    }

    // What the source repository holds at the pinned commit.
    async function depsFor(
      files: Record<string, string>,
      calls: { download: number },
    ) {
      const storage = await import("./index");
      return {
        downloadZip: async () => {
          calls.download += 1;
          return Buffer.from("zip");
        },
        readEntries: async (_zip: Buffer, keep: (path: string) => boolean) =>
          new Map(
            Object.entries(files)
              .filter(([path]) => keep(path))
              .map(([path, text]) => [path, Buffer.from(text)]),
          ),
        putBlob: storage.putSkillBlob,
        putBundle: storage.putSkillBundle,
      } as unknown as import("./restore").SkillRestoreDeps;
    }

    test("lost objects come back from the pinned commit, byte for byte", async () => {
      const skill = await registrySkill();
      const keys = [
        ...skill.rows.map((row) => row.objectKey!),
        skill.version.bundleObjectKey!,
      ];
      const before = new Map(keys.map((key) => [key, store.objects.get(key)!]));
      for (const key of keys) store.objects.delete(key);

      const calls = { download: 0 };
      const deps = await depsFor(
        {
          "skills/restorable/SKILL.md": skillMd,
          "skills/restorable/scripts/run.py": script,
          // Not in the indexed manifest: never fetched into storage.
          "skills/restorable/extra.txt": "not indexed",
          "README.md": "repository readme",
        },
        calls,
      );
      // Two readers hitting the same miss share one download.
      await Promise.all([
        restore.restoreSkillVersionFromSource(skill.skillVersionId, deps),
        restore.restoreSkillVersionFromSource(skill.skillVersionId, deps),
      ]);
      expect(calls.download).toBe(1);
      for (const [key, bytes] of before)
        expect(store.objects.get(key)?.equals(bytes)).toBe(true);
    });

    test("a source that no longer matches restores nothing", async () => {
      const skill = await registrySkill();
      const keys = skill.rows.map((row) => row.objectKey!);
      for (const key of keys) store.objects.delete(key);
      const size = store.objects.size;

      await expect(
        restore.restoreSkillVersionFromSource(
          skill.skillVersionId,
          await depsFor(
            {
              "skills/restorable/SKILL.md": skillMd,
              "skills/restorable/scripts/run.py": "print('tampered')\n",
            },
            { download: 0 },
          ),
        ),
      ).rejects.toMatchObject({ code: "SKILL_SOURCE_MISMATCH" });
      // Not even the file that did match: all or nothing.
      expect(store.objects.size).toBe(size);

      await expect(
        restore.restoreSkillVersionFromSource(
          skill.skillVersionId,
          await depsFor(
            { "skills/restorable/SKILL.md": skillMd },
            { download: 0 },
          ),
        ),
      ).rejects.toMatchObject({ code: "SKILL_SOURCE_MISMATCH" });
    });

    test("an unreachable source says so; a version with no source keeps its own error", async () => {
      const skill = await registrySkill();
      const storage = await import("./index");
      await expect(
        restore.restoreSkillVersionFromSource(skill.skillVersionId, {
          downloadZip: async () => {
            throw new Error("GitHub zipball download failed 404");
          },
          readEntries: async () => new Map(),
          putBlob: storage.putSkillBlob,
          putBundle: storage.putSkillBundle,
        } as unknown as import("./restore").SkillRestoreDeps),
      ).rejects.toMatchObject({ code: "SKILL_SOURCE_UNAVAILABLE" });

      await expect(
        restore.restoreSkillVersionFromSource(`missing-${randomUUID()}`),
      ).rejects.toMatchObject({ code: "SKILL_SOURCE_NONE" });
      const miss = Object.assign(new Error("gone"), { name: "NoSuchKey" });
      await expect(
        restore.withSkillSourceRestore(`missing-${randomUUID()}`, async () => {
          throw miss;
        }),
      ).rejects.toBe(miss);
      // Anything that is not a miss is never treated as one.
      const other = new Error("FILE_TOO_LARGE");
      await expect(
        restore.withSkillSourceRestore(skill.skillVersionId, async () => {
          throw other;
        }),
      ).rejects.toBe(other);
    });
  },
);
