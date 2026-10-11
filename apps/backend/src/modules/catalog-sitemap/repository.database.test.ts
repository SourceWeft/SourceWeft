import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";
import {
  seedSkillDefinition,
  seedSkillVersion,
} from "../../test/skill-database";

describe("catalog sitemap public boundary on PostgreSQL", () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let data: typeof import("@sourceweft/db");
  let repository: typeof import("./repository");
  const originalUrl = process.env.DATABASE_URL;
  const prefix = (id: string) =>
    createHash("md5").update(id).digest("hex").slice(0, 1);
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase("sitemaps");
    process.env.DATABASE_URL = isolated.url;
    data = await import("@sourceweft/db");
    repository = await import("./repository");
  }, 120_000);
  afterAll(async () => {
    if (data) await data.closeDatabase();
    if (isolated) await isolated.close();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });
  test("retains only publicly readable skills and only their visible current locales", async () => {
    const visible = await seedSkillDefinition(data, {
      slug: "sitemap-visible",
    });
    const version = await seedSkillVersion(data, {
      skillId: visible,
      storageType: "db_text",
      storagePointer: "fixture:visible",
      contentHash: "a".repeat(64),
      publishedAt: new Date("2026-01-01"),
    });
    const overview = {
      summary: "Summary",
      whatItDoes: "Work",
      whenToUse: "When",
      requirements: "",
      suggestedCategories: [],
    };
    await data.db.insert(data.skillVersionOverviews).values([
      {
        skillVersionId: version,
        locale: "en",
        overview,
        model: "test",
        bundleSha256: "a".repeat(64),
        generatedAt: new Date("2025-12-01"),
      },
      {
        skillVersionId: version,
        locale: "zh-CN",
        overview,
        model: "test",
        bundleSha256: "a".repeat(64),
        hidden: true,
        generatedAt: new Date("2025-12-01"),
      },
    ]);
    for (const name of [
      "restricted",
      "archived",
      "builtin",
      "draft",
      "not-current",
      "hidden",
    ]) {
      const id = await seedSkillDefinition(data, {
        slug: "sitemap-" + name,
        ...(name === "restricted" ? { visibility: "restricted" as const } : {}),
        ...(name === "archived" ? { status: "archived" as const } : {}),
        ...(name === "builtin" ? { sourceType: "builtin" as const } : {}),
      });
      await seedSkillVersion(data, {
        skillId: id,
        storageType: "db_text",
        storagePointer: "fixture:" + name,
        contentHash: "a".repeat(64),
        status: name === "draft" ? "draft" : "published",
        isCurrent: name !== "not-current",
        manifestJson: {
          slug: "sitemap-" + name,
          displayName: name,
          version: "1.0.0",
          description: "fixture",
          visibility: "public",
          categories: [],
          ...(name === "hidden" ? { listing: "hidden" as const } : {}),
        },
      });
    }
    const index = await repository.readCatalogSitemapIndex();
    expect(
      index.shards
        .filter((s) => s.kind === "skills")
        .reduce((n, s) => n + s.count, 0),
    ).toBe(1);
    const result = await repository.readCatalogSitemapShard(
      "skills",
      prefix(visible),
    );
    expect(result.items).toEqual([
      {
        key: "sitemap-visible",
        updatedAt: "2026-01-01T00:00:00.000Z",
        overviewLocales: ["en"],
      },
    ]);
    await expect(
      repository.readCatalogSitemapShard("skills", "%"),
    ).rejects.toThrow();
  });
  test("MCP includes desktop details but excludes nonpublic and unpublished servers", async () => {
    const id = randomUUID();
    await data.db.insert(data.mcpServers).values({
      id,
      identifier: "io.github.test/desktop",
      name: "Desktop",
      status: "published",
      visibility: "public",
      desktopOnly: true,
    });
    for (const status of ["draft", "unlisted", "archived"] as const)
      await data.db.insert(data.mcpServers).values({
        id: randomUUID(),
        identifier: "io.github.test/" + status,
        name: status,
        status,
        visibility: "public",
      });
    await data.db.insert(data.mcpServers).values({
      id: randomUUID(),
      identifier: "io.github.test/private",
      name: "Private",
      status: "published",
      visibility: "private",
    });
    const index = await repository.readCatalogSitemapIndex();
    expect(
      index.shards
        .filter((s) => s.kind === "mcp")
        .reduce((n, s) => n + s.count, 0),
    ).toBe(1);
    const overview = {
      summary: "Summary",
      whatItDoes: "Work",
      whenToUse: "When",
      requirements: "",
      suggestedCategories: [],
    };
    const old = randomUUID(),
      current = randomUUID(),
      draft = randomUUID();
    await data.db.insert(data.mcpServerVersions).values([
      {
        id: old,
        serverId: id,
        version: "1",
        status: "published",
        publishedAt: new Date("2024-01-01"),
      },
      {
        id: current,
        serverId: id,
        version: "2",
        status: "published",
        publishedAt: new Date("2026-01-01"),
      },
      {
        id: draft,
        serverId: id,
        version: "3",
        status: "draft",
        publishedAt: new Date("2027-01-01"),
      },
    ]);
    await data.db.insert(data.mcpServerVersionOverviews).values([
      {
        mcpServerVersionId: old,
        locale: "zh-TW",
        overview,
        model: "test",
        inputSha256: "a".repeat(64),
      },
      {
        mcpServerVersionId: current,
        locale: "en",
        overview,
        model: "test",
        inputSha256: "b".repeat(64),
      },
      {
        mcpServerVersionId: current,
        locale: "zh-CN",
        overview,
        model: "test",
        inputSha256: "b".repeat(64),
        hidden: true,
      },
      {
        mcpServerVersionId: draft,
        locale: "zh-TW",
        overview,
        model: "test",
        inputSha256: "c".repeat(64),
      },
    ]);
    const result = await repository.readCatalogSitemapShard("mcp", prefix(id));
    expect(result.items.map((i) => i.key)).toEqual(["io.github.test/desktop"]);
    expect(result.items[0]?.overviewLocales).toEqual(["en"]);
  });

  describe("lastmod follows the page's content, not sync runs", () => {
    const overview = {
      summary: "Summary",
      whatItDoes: "Work",
      whenToUse: "When",
      requirements: "",
      suggestedCategories: [],
    };

    /** A public server updated at `updatedAt` with published versions. */
    async function seedServer(
      name: string,
      updatedAt: string,
      versions: Array<{
        publishedAt: string;
        overviews?: Array<{
          generatedAt: string;
          hidden?: boolean;
          locale?: "en" | "zh-CN" | "zh-TW";
        }>;
      }>,
    ) {
      const id = randomUUID();
      const identifier = "io.github.lastmod/" + name;
      await data.db.insert(data.mcpServers).values({
        id,
        identifier,
        name,
        status: "published",
        visibility: "public",
        updatedAt: new Date(updatedAt),
      });
      const versionIds: string[] = [];
      for (const [index, version] of versions.entries()) {
        const versionId = randomUUID();
        versionIds.push(versionId);
        await data.db.insert(data.mcpServerVersions).values({
          id: versionId,
          serverId: id,
          version: String(index + 1),
          status: "published",
          publishedAt: new Date(version.publishedAt),
        });
        for (const row of version.overviews ?? [])
          await data.db.insert(data.mcpServerVersionOverviews).values({
            mcpServerVersionId: versionId,
            locale: row.locale ?? "en",
            overview,
            model: "test",
            inputSha256: "d".repeat(64),
            hidden: row.hidden ?? false,
            generatedAt: new Date(row.generatedAt),
          });
      }
      return { id, identifier, versionIds };
    }

    async function lastmodOf(kind: "mcp" | "skills", id: string, key: string) {
      const shard = await repository.readCatalogSitemapShard(kind, prefix(id));
      return shard.items.find((item) => item.key === key)?.updatedAt;
    }

    test("an overview generated after the last edit moves lastmod to it", async () => {
      const server = await seedServer("overview-later", "2026-03-01", [
        {
          publishedAt: "2026-02-01",
          overviews: [
            { generatedAt: "2026-04-01" },
            { generatedAt: "2026-05-01", locale: "zh-CN" },
          ],
        },
      ]);
      expect(await lastmodOf("mcp", server.id, server.identifier)).toBe(
        "2026-05-01T00:00:00.000Z",
      );
    });

    test("an overview older than the last edit leaves lastmod at the edit", async () => {
      const server = await seedServer("overview-earlier", "2026-03-01", [
        {
          publishedAt: "2026-02-01",
          overviews: [{ generatedAt: "2026-02-15" }],
        },
      ]);
      expect(await lastmodOf("mcp", server.id, server.identifier)).toBe(
        "2026-03-01T00:00:00.000Z",
      );
    });

    test("only the shown version's overviews count", async () => {
      // The newer overview belongs to the version the page no longer shows.
      const server = await seedServer("overview-old-version", "2026-03-01", [
        {
          publishedAt: "2026-01-01",
          overviews: [{ generatedAt: "2026-09-01" }],
        },
        {
          publishedAt: "2026-02-01",
          overviews: [{ generatedAt: "2026-04-01" }],
        },
      ]);
      expect(await lastmodOf("mcp", server.id, server.identifier)).toBe(
        "2026-04-01T00:00:00.000Z",
      );
    });

    test("a hidden overview still counts, so hiding never moves lastmod back", async () => {
      const server = await seedServer("overview-hidden", "2026-03-01", [
        {
          publishedAt: "2026-02-01",
          overviews: [{ generatedAt: "2026-06-01", hidden: true }],
        },
      ]);
      expect(await lastmodOf("mcp", server.id, server.identifier)).toBe(
        "2026-06-01T00:00:00.000Z",
      );
    });

    test("a README recheck that changed nothing leaves lastmod alone", async () => {
      // A not_modified README fetch only restamps readme_fetched_at.
      const server = await seedServer("readme-recheck", "2026-03-01", [
        {
          publishedAt: "2026-02-01",
          overviews: [{ generatedAt: "2026-04-01" }],
        },
      ]);
      const before = await lastmodOf("mcp", server.id, server.identifier);
      await data.db
        .update(data.mcpServerVersions)
        .set({ readmeFetchedAt: new Date("2026-10-01") })
        .where(eq(data.mcpServerVersions.id, server.versionIds[0]!));
      expect(before).toBe("2026-04-01T00:00:00.000Z");
      expect(await lastmodOf("mcp", server.id, server.identifier)).toBe(before);
    });

    test("a skill's lastmod is the later of its publication and its current version's overviews", async () => {
      const seedSkill = async (
        slug: string,
        generatedAt: string,
        stale?: string,
      ) => {
        const id = await seedSkillDefinition(data, { slug });
        if (stale) {
          const old = await seedSkillVersion(data, {
            skillId: id,
            version: "0.9.0",
            isCurrent: false,
            storageType: "db_text",
            storagePointer: "fixture:" + slug + "-old",
            contentHash: "c".repeat(64),
            publishedAt: new Date("2026-01-01"),
          });
          await data.db.insert(data.skillVersionOverviews).values({
            skillVersionId: old,
            locale: "en",
            overview,
            model: "test",
            bundleSha256: "c".repeat(64),
            generatedAt: new Date(stale),
          });
        }
        const version = await seedSkillVersion(data, {
          skillId: id,
          storageType: "db_text",
          storagePointer: "fixture:" + slug,
          contentHash: "b".repeat(64),
          publishedAt: new Date("2026-03-01"),
        });
        await data.db.insert(data.skillVersionOverviews).values({
          skillVersionId: version,
          locale: "en",
          overview,
          model: "test",
          bundleSha256: "b".repeat(64),
          hidden: true,
          generatedAt: new Date(generatedAt),
        });
        return id;
      };
      const later = await seedSkill("lastmod-later", "2026-05-01");
      const earlier = await seedSkill("lastmod-earlier", "2026-02-01");
      const superseded = await seedSkill(
        "lastmod-superseded",
        "2026-02-01",
        "2026-09-01",
      );
      expect(await lastmodOf("skills", later, "lastmod-later")).toBe(
        "2026-05-01T00:00:00.000Z",
      );
      expect(await lastmodOf("skills", earlier, "lastmod-earlier")).toBe(
        "2026-03-01T00:00:00.000Z",
      );
      expect(await lastmodOf("skills", superseded, "lastmod-superseded")).toBe(
        "2026-03-01T00:00:00.000Z",
      );
    });
  });
});
