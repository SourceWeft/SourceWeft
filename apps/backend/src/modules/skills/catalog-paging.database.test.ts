import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, test } from "vitest";
import { inArray } from "drizzle-orm";

// Paging is an ORDER BY + keyset predicate in SQL, so "every skill exactly
// once" is only provable against PostgreSQL (its collation decides the order).
describe.skipIf(process.env.RUN_SKILL_DB_TESTS !== "1")(
  "catalog paging against real PostgreSQL",
  () => {
    let data: typeof import("@sourceweft/db");
    let service: import("./service").ContentSkillsService;
    const tag = randomUUID().slice(0, 8);
    const owner = {
      teamId: `skill-team-${randomUUID()}`,
      workspaceId: `skill-ws-${randomUUID()}`,
      userId: `paging-owner-${tag}`,
    };
    const stranger = {
      teamId: `skill-team-${randomUUID()}`,
      workspaceId: `skill-ws-${randomUUID()}`,
      userId: `paging-stranger-${tag}`,
    };
    // More than the old unordered LIMIT 100 window.
    const PUBLIC_COUNT = 130;
    const definitionIds: string[] = [];
    const publicSlugs: string[] = [];
    const lastSlug = `gh-paging-${tag}-zz-last`;
    const restrictedSlug = `gh-paging-${tag}-restricted`;
    const hiddenSlug = `gh-paging-${tag}-hidden`;

    function fixture(input: {
      slug: string;
      displayName: string;
      visibility: "public" | "restricted";
      listing?: "hidden";
    }) {
      const skillId = randomUUID();
      definitionIds.push(skillId);
      return {
        definition: {
          id: skillId,
          sourceType: "registry_github" as const,
          slug: input.slug,
          displayName: input.displayName,
          description: `fixture ${tag}`,
          visibility: input.visibility,
          status: "active" as const,
          ownerUserId: owner.userId,
        },
        version: {
          id: randomUUID(),
          skillId,
          version: "aaaaaaaaaaaa",
          status: "published" as const,
          // Community skills are `object` versions: SKILL.md on the row, bytes in
          // object storage (not needed by these tests, so the keys are inert).
          storageType: "object" as const,
          skillMd: "---\nname: fixture\ndescription: fixture\n---\n",
          bundleSha256: "0".repeat(64),
          bundleObjectKey: `skills/bundles/${"0".repeat(64)}.zip`,
          bundleSizeBytes: 1,
          storagePointer: `github:fixture/skills@${"a".repeat(40)}#x`,
          isCurrent: true,
          contentHash: "hash",
          manifestJson: {
            slug: input.slug,
            displayName: input.displayName,
            version: "aaaaaaaaaaaa",
            description: `fixture ${tag}`,
            visibility: input.visibility,
            categories: [],
            ...(input.listing ? { listing: input.listing } : {}),
          },
        },
      };
    }

    async function walk(
      viewer: typeof owner,
      options: { limit: number; query?: string },
    ) {
      const pages: string[][] = [];
      let cursor: string | undefined;
      do {
        const page = await service.listCatalog({
          ...viewer,
          limit: options.limit,
          query: options.query,
          // These tests are about paging as such and assert the name order;
          // the market's sorts have their own suite (market/catalog-market).
          sort: "name",
          cursor,
        });
        pages.push(page.items.map((item) => item.slug));
        cursor = page.nextCursor ?? undefined;
        assert.ok(pages.length < 1000, "paging did not terminate");
      } while (cursor);
      return pages;
    }

    beforeAll(async () => {
      if (
        !new URL(process.env.DATABASE_URL!).pathname.startsWith(
          "/sourceweft_skillv6_",
        )
      )
        throw new Error("Refusing non-isolated database");
      data = await import("@sourceweft/db");
      service = new (await import("./service")).ContentSkillsService();
      for (const scope of [owner, stranger])
        await data.db.insert(data.workspaces).values({
          id: scope.workspaceId,
          organizationId: scope.teamId,
          name: "Catalog paging tests",
          slug: randomUUID(),
        });

      const fixtures = [];
      for (let index = 0; index < PUBLIC_COUNT - 1; index += 1) {
        const slug = `gh-paging-${tag}-${String(index).padStart(3, "0")}`;
        publicSlugs.push(slug);
        fixtures.push(
          fixture({
            slug,
            // Every third name is shared, so the id tie-break is exercised.
            displayName:
              index % 3 === 0
                ? `Paging ${tag} shared`
                : `Paging ${tag} ${slug}`,
            visibility: "public",
          }),
        );
      }
      publicSlugs.push(lastSlug);
      fixtures.push(
        fixture({
          slug: lastSlug,
          displayName: `Paging ${tag} zzzz last`,
          visibility: "public",
        }),
        fixture({
          slug: restrictedSlug,
          displayName: `Paging ${tag} restricted`,
          visibility: "restricted",
        }),
        fixture({
          slug: hiddenSlug,
          displayName: `Paging ${tag} hidden`,
          visibility: "public",
          listing: "hidden",
        }),
      );
      await data.db
        .insert(data.skillDefinitions)
        .values(fixtures.map((entry) => entry.definition));
      await data.db
        .insert(data.skillVersions)
        .values(fixtures.map((entry) => entry.version));
    });

    afterAll(async () => {
      if (!data) return;
      // Versions go with their definition (ON DELETE CASCADE).
      if (definitionIds.length > 0)
        await data.db
          .delete(data.skillDefinitions)
          .where(inArray(data.skillDefinitions.id, definitionIds));
      await data.db
        .delete(data.workspaces)
        .where(
          inArray(data.workspaces.id, [
            owner.workspaceId,
            stranger.workspaceId,
          ]),
        );
      await data.closeDatabase();
    });

    test("paging returns every visible registry skill exactly once, in a stable order", async () => {
      const pages = await walk(stranger, { limit: 25, query: tag });
      const slugs = pages.flat();
      assert.equal(new Set(slugs).size, slugs.length, "a skill was repeated");
      assert.deepEqual([...slugs].sort(), [...publicSlugs].sort());
      assert.equal(pages.length, Math.ceil(PUBLIC_COUNT / 25));
      assert.ok(pages.slice(0, -1).every((page) => page.length === 25));

      // Same walk, same order — and a different page size cuts the same
      // sequence, so the order belongs to the data and not to the paging.
      assert.deepEqual(
        (await walk(stranger, { limit: 25, query: tag })).flat(),
        slugs,
      );
      assert.deepEqual(
        (await walk(stranger, { limit: 100, query: tag })).flat(),
        slugs,
      );
      assert.equal(slugs.at(-1), lastSlug);
    });

    test("the unfiltered catalog pages the same way, first-page extras included once", async () => {
      const slugs = (await walk(stranger, { limit: 100 })).flat();
      assert.equal(new Set(slugs).size, slugs.length, "a skill was repeated");
      for (const slug of publicSlugs)
        assert.ok(slugs.includes(slug), `${slug} is missing`);
      assert.ok(!slugs.includes(hiddenSlug));
      assert.ok(!slugs.includes(restrictedSlug));
    });

    test("a restricted skill is paged to its submitter only", async () => {
      const mine = (await walk(owner, { limit: 50, query: tag })).flat();
      assert.ok(mine.includes(restrictedSlug));
      assert.equal(mine.length, PUBLIC_COUNT + 1);
    });

    test("by-slug finds a skill beyond the first page without listing the catalog", async () => {
      const firstPage = await service.listCatalog({
        ...stranger,
        query: tag,
        sort: "name",
      });
      assert.equal(firstPage.items.length, 50);
      assert.ok(firstPage.nextCursor);
      assert.ok(!firstPage.items.some((item) => item.slug === lastSlug));

      const listCatalog = service.listCatalog;
      service.listCatalog = () => {
        throw new Error("by-slug must not list the catalog");
      };
      try {
        const detail = await service.getCatalogSkillDetailBySlug({
          ...stranger,
          slug: lastSlug,
        });
        assert.equal(detail.skill.slug, lastSlug);
        assert.equal(detail.skill.sourceType, "registry_github");
        assert.equal(detail.skill.publisher, "Community");

        // The catalogId form resolves the same skill, equally directly.
        const byId = await service.getCatalogSkillDetail({
          ...stranger,
          catalogId: detail.skill.catalogId,
        });
        assert.deepEqual(byId.skill, detail.skill);
      } finally {
        service.listCatalog = listCatalog;
      }
    });

    test("by-slug keeps the catalog's visibility rules", async () => {
      const mine = await service.getCatalogSkillDetailBySlug({
        ...owner,
        slug: restrictedSlug,
      });
      assert.equal(mine.skill.slug, restrictedSlug);
      for (const slug of [restrictedSlug, hiddenSlug, `gh-paging-${tag}-nope`])
        await assert.rejects(
          service.getCatalogSkillDetailBySlug({ ...stranger, slug }),
          (error: { code?: string }) => error.code === "SKILL_NOT_FOUND",
          slug,
        );
    });

    test("a malformed cursor is refused", async () => {
      await assert.rejects(
        service.listCatalog({ ...stranger, cursor: "not-a-cursor" }),
        (error: { code?: string }) => error.code === "INVALID_CURSOR",
      );
    });
  },
);
