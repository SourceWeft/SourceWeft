import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";

// PostgreSQL is real; object storage is a map that records every read. The
// rows are seeded here in the `object` shape directly — what is under test is
// the READ side: which bodies leave storage, and when.
const store = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
  reads: [] as string[],
}));
vi.mock("../sources/storage", () => ({
  getContentStorageBucketName: () => "bucket",
  downloadFileObject: async ({ key }: { key: string }) => {
    store.reads.push(key);
    return store.objects.get(key)!;
  },
}));

describe.skipIf(process.env.RUN_SKILL_DB_TESTS !== "1")(
  "reading skills by storage type against real PostgreSQL",
  () => {
    let data: typeof import("@sourceweft/db");
    let skills: typeof import("./repository");
    let selection: typeof import("./selection");
    let versions: typeof import("./registry/versions");
    const teamId = `skill-team-${randomUUID()}`;
    const workspaceId = `skill-ws-${randomUUID()}`;
    const viewer = { teamId, workspaceId, userId: "object-reader" };
    const definitionIds: string[] = [];

    beforeAll(async () => {
      if (
        !new URL(process.env.DATABASE_URL!).pathname.startsWith(
          "/sourceweft_skillv6_",
        )
      )
        throw new Error("Refusing non-isolated database");
      data = await import("@sourceweft/db");
      skills = await import("./repository");
      selection = await import("./selection");
      versions = await import("./registry/versions");
      await data.db.insert(data.workspaces).values({
        id: workspaceId,
        organizationId: teamId,
        name: "Object read tests",
        slug: randomUUID(),
      });
    });
    afterAll(async () => {
      if (!data) return;
      for (const id of definitionIds)
        await data.db
          .delete(data.skillDefinitions)
          .where(eq(data.skillDefinitions.id, id));
      await data.db
        .delete(data.workspaces)
        .where(eq(data.workspaces.id, workspaceId));
      await data.closeDatabase();
    });
    beforeEach(() => {
      store.reads = [];
    });

    const sha = (bytes: Uint8Array | string) =>
      createHash("sha256").update(bytes).digest("hex");

    function blob(bytes: Uint8Array | string) {
      const body = Buffer.from(bytes);
      const digest = sha(body);
      const objectKey = `skills/blobs/${digest.slice(0, 2)}/${digest}`;
      store.objects.set(objectKey, body);
      return { objectKey, contentHash: digest, sizeBytes: body.byteLength };
    }

    async function seedDefinition(
      sourceType: "registry_github" | "workspace_custom",
    ) {
      const skillId = randomUUID();
      const slug =
        sourceType === "registry_github"
          ? `gh-fixture-${randomUUID().slice(0, 8)}-read`
          : `custom-${randomUUID().slice(0, 8)}`;
      definitionIds.push(skillId);
      await data.db.insert(data.skillDefinitions).values({
        id: skillId,
        sourceType,
        slug,
        displayName: slug,
        description: "fixture",
        // Public / workspace-owned, so visibility is not what is under test.
        ...(sourceType === "registry_github"
          ? { visibility: "public" as const }
          : { visibility: "workspace" as const, teamId, workspaceId }),
        status: "active",
        ownerUserId: viewer.userId,
      });
      return { skillId, slug };
    }

    function manifestJson(slug: string, version: string) {
      return {
        slug,
        displayName: slug,
        version,
        description: "fixture",
        visibility: "restricted" as const,
        categories: [],
      };
    }

    const FONT = new Uint8Array([0, 1, 2, 255, 254]);

    /** An `object` version: skill_md + bundle on the version, a blob per file. */
    async function seedObjectVersion(input: {
      skillId: string;
      slug: string;
      marker: string;
      createdAt: Date;
      files: Array<{ path: string; mimeType: string; body: Uint8Array | string }>;
    }) {
      const versionId = randomUUID();
      const version = input.marker.repeat(12);
      const skillMd = String(
        input.files.find((file) => file.path === "SKILL.md")!.body,
      );
      const bundleSha = sha(`bundle-${versionId}`);
      await data.db.insert(data.skillVersions).values({
        id: versionId,
        skillId: input.skillId,
        version,
        status: "published",
        storageType: "object",
        storagePointer: `github:fixture/skills@${input.marker.repeat(40)}#read`,
        isCurrent: false,
        contentHash: bundleSha,
        skillMd,
        bundleSha256: bundleSha,
        bundleObjectKey: `skills/bundles/${bundleSha}.zip`,
        bundleSizeBytes: 4096,
        manifestJson: manifestJson(input.slug, version),
        createdAt: input.createdAt,
        publishedAt: input.createdAt,
      });
      await data.db.insert(data.skillVersionFiles).values(
        input.files.map((file) => ({
          id: randomUUID(),
          skillVersionId: versionId,
          path: file.path,
          mimeType: file.mimeType,
          ...blob(file.body),
        })),
      );
      return versionId;
    }

    async function seedObjectSkill() {
      const { skillId, slug } = await seedDefinition("registry_github");
      const versionId = await seedObjectVersion({
        skillId,
        slug,
        marker: "a",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        files: [
          { path: "SKILL.md", mimeType: "text/markdown", body: "# Brand\nrules" },
          { path: "README.md", mimeType: "text/markdown", body: "# Hello\nintro" },
          { path: "reference/guide.md", mimeType: "text/markdown", body: "guide" },
          { path: "assets/brand.ttf", mimeType: "font/ttf", body: FONT },
        ],
      });
      return { skillId, slug, versionId };
    }

    test("an object version loads as a manifest: no body in the rows, none fetched", async () => {
      const { skillId, versionId } = await seedObjectSkill();
      const bundle = await skills.loadSkillVersionBundle({
        ...viewer,
        skillId,
        skillVersionId: versionId,
      });
      expect(bundle!.version).toMatchObject({
        storageType: "object",
        skillMd: "# Brand\nrules",
        bundleSizeBytes: 4096,
      });
      // Row order is the database's collation; only the set matters here.
      expect(bundle!.files.map((file) => file.path).sort()).toEqual([
        "README.md",
        "SKILL.md",
        "assets/brand.ttf",
        "reference/guide.md",
      ]);
      for (const file of bundle!.files) {
        expect(file.contentText).toBeNull();
        expect(file.objectKey).toMatch(/^skills\/blobs\//);
      }
      expect(store.reads).toEqual([]);
    });

    test("a single file is read from its blob; a binary is reported without a fetch", async () => {
      const { versionId } = await seedObjectSkill();
      expect(
        await skills.readSkillVersionFile({
          skillVersionId: versionId,
          path: "reference/guide.md",
        }),
      ).toEqual({ text: "guide" });
      expect(store.reads).toHaveLength(1);

      expect(
        await skills.readSkillVersionFile({
          skillVersionId: versionId,
          path: "assets/brand.ttf",
        }),
      ).toEqual({ binary: true, sizeBytes: FONT.byteLength });
      expect(store.reads).toHaveLength(1);

      expect(
        await skills.readSkillVersionFile({
          skillVersionId: versionId,
          path: "missing.md",
        }),
      ).toBeNull();
    });

    test("turn start for N enabled object skills performs zero blob reads; reads are lazy and cached", async () => {
      const seeded = [
        await seedObjectSkill(),
        await seedObjectSkill(),
        await seedObjectSkill(),
      ];
      for (const skill of seeded) {
        await skills.upsertWorkspaceSkill({
          ...viewer,
          skillId: skill.skillId,
          skillVersionId: skill.versionId,
          enabledBy: viewer.userId,
        });
      }

      const resolved = await selection.resolveSelectedSkills({
        ...viewer,
        skillIds: [],
      });

      const mine = resolved.filter((skill) =>
        seeded.some((seed) => seed.slug === skill.name),
      );
      expect(mine).toHaveLength(3);
      expect(store.reads).toEqual([]);
      for (const skill of mine) {
        expect(skill.skillMd).toBe("# Brand\nrules");
        expect(skill.bundle?.objectKey).toMatch(/^skills\/bundles\//);
        expect(
          skill.files
            .map((file) => [file.path, file.isText])
            .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
        ).toEqual([
          ["README.md", true],
          ["SKILL.md", true],
          ["assets/brand.ttf", false],
          ["reference/guide.md", true],
        ]);
      }

      const skill = mine[0]!;
      expect(await skill.readFile!("reference/guide.md")).toEqual({
        text: "guide",
      });
      await skill.readFile!("reference/guide.md");
      expect(await skill.readFile!("assets/brand.ttf")).toEqual({
        binary: true,
        sizeBytes: FONT.byteLength,
      });
      expect(store.reads).toHaveLength(1);
    });

    test("a db_text version keeps bodies in its rows: documents ride the manifest, the rest is read on demand", async () => {
      const { skillId, slug } = await seedDefinition("workspace_custom");
      const versionId = randomUUID();
      await data.db.insert(data.skillVersions).values({
        id: versionId,
        skillId,
        version: "1.0.0",
        status: "published",
        storageType: "db_text",
        storagePointer: `db://${versionId}`,
        isCurrent: true,
        contentHash: "hash",
        manifestJson: { ...manifestJson(slug, "1.0.0"), visibility: "workspace" },
      });
      const rows = [
        { path: "SKILL.md", contentText: "# Custom\nbody" },
        { path: "readme.MD", contentText: "about" },
        { path: "reference/notes.md", contentText: "notes body" },
      ];
      await data.db.insert(data.skillVersionFiles).values(
        rows.map((row) => ({
          id: randomUUID(),
          skillVersionId: versionId,
          path: row.path,
          contentText: row.contentText,
          mimeType: "text/markdown",
          sizeBytes: Buffer.byteLength(row.contentText),
          contentHash: sha(row.contentText),
        })),
      );

      const bundle = await skills.loadSkillVersionBundle({
        ...viewer,
        skillId,
        skillVersionId: versionId,
      });
      expect(
        Object.fromEntries(
          bundle!.files.map((file) => [file.path, file.contentText]),
        ),
      ).toEqual({
        "SKILL.md": "# Custom\nbody",
        "readme.MD": "about",
        "reference/notes.md": null,
      });

      const installed = await skills.upsertWorkspaceSkill({
        ...viewer,
        skillId,
        skillVersionId: versionId,
        enabledBy: viewer.userId,
      });
      const [skill] = await selection.resolveSelectedSkills({
        ...viewer,
        skillIds: [installed.id],
      }).then((all) => all.filter((entry) => entry.name === slug));
      expect(skill!.skillMd).toBe("# Custom\nbody");
      expect(skill!.bundle).toBeUndefined();
      expect(await skill!.readFile!("reference/notes.md")).toEqual({
        text: "notes body",
      });
      expect(store.reads).toEqual([]);
    });

    test("version detail reads SKILL.md from skill_md, README from its blob, and diffs by digest only", async () => {
      const { skillId, slug, versionId: older } = await seedObjectSkill();
      const newer = await seedObjectVersion({
        skillId,
        slug,
        marker: "b",
        createdAt: new Date("2026-02-01T00:00:00Z"),
        files: [
          { path: "SKILL.md", mimeType: "text/markdown", body: "# Brand v2" },
          { path: "README.md", mimeType: "text/markdown", body: "# Hello\nintro" },
          { path: "assets/logo.png", mimeType: "image/png", body: FONT },
          { path: "assets/brand.ttf", mimeType: "font/ttf", body: FONT },
        ],
      });

      const detail = await versions.getRegistryVersionDetail({
        ...viewer,
        catalogId: skillId,
        versionId: newer,
      });

      expect(detail.skillContent).toBe("# Brand v2");
      expect(detail.readmePath).toBe("README.md");
      expect(detail.readmeContent).toBe("# Hello\nintro");
      // Exactly one body left storage: the README.
      expect(store.reads).toEqual([blob("# Hello\nintro").objectKey]);
      expect(detail.files.map((file) => file.path).sort()).toEqual([
        "README.md",
        "SKILL.md",
        "assets/brand.ttf",
        "assets/logo.png",
      ]);
      expect(detail.changes).toEqual({
        added: ["assets/logo.png"],
        removed: ["reference/guide.md"],
        changed: ["SKILL.md"],
      });

      store.reads = [];
      const first = await versions.getRegistryVersionDetail({
        ...viewer,
        catalogId: skillId,
        versionId: older,
      });
      expect(first.skillContent).toBe("# Brand\nrules");
      expect(first.changes.removed).toEqual([]);
    });
  },
);
