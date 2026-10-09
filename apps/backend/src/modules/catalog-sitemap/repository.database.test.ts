import { createHash, randomUUID } from "node:crypto";
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
      },
      {
        skillVersionId: version,
        locale: "zh-CN",
        overview,
        model: "test",
        bundleSha256: "a".repeat(64),
        hidden: true,
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
});
