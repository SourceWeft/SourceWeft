import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, test, vi } from "vitest";
import { inArray, sql } from "drizzle-orm";
import type { SkillCatalogSort } from "@sourceweft/contracts";

// The admin routes are driven over HTTP against the real database; only who is
// calling is decided here.
const auth = vi.hoisted(() => ({ userId: "", admins: [] as string[] }));
vi.mock("../../../api/middleware/auth-session", () => ({
  getSessionUserId: () => auth.userId,
  requireSession: async () => ({ user: { id: auth.userId } }),
}));
vi.mock("../../market/admin", () => ({
  isMarketAdmin: (userId: string) => auth.admins.includes(userId),
}));

/**
 * The catalog's market surface against real PostgreSQL: every sort pages
 * through the registry without a gap or a repeat, the filters select in SQL,
 * category counts follow the viewer, a public skill's text is for everyone,
 * and the admin routes move a skill's standing the way they say.
 *
 * Everything is scoped to this file's own rows — by a tag in the search query,
 * or by viewers nobody else has — because other suites share the database.
 */
describe.skipIf(process.env.RUN_SKILL_DB_TESTS !== "1")(
  "catalog market surface (real PostgreSQL)",
  () => {
    let data: typeof import("@sourceweft/db");
    let service: import("../service").ContentSkillsService;
    let skills: typeof import("../repository");
    let rank: typeof import("./rank");
    let taxonomy: typeof import("./taxonomy");
    let app: Hono;

    const tag = randomUUID().slice(0, 8);
    const owner = {
      teamId: `skill-team-${randomUUID()}`,
      workspaceId: `skill-ws-${randomUUID()}`,
      userId: `market-owner-${tag}`,
    };
    const stranger = {
      teamId: `skill-team-${randomUUID()}`,
      workspaceId: `skill-ws-${randomUUID()}`,
      userId: `market-stranger-${tag}`,
    };
    const adminUserId = `market-admin-${tag}`;
    // Workspaces that exist to install things. `install_count` is refreshed
    // from the install rows — by other suites too, for every skill at once —
    // so a count a fixture merely claimed would be overwritten mid-test. The
    // fixtures' counts are real installs instead.
    const installers = [0, 1, 2].map(() => ({
      teamId: `skill-team-${randomUUID()}`,
      workspaceId: `skill-ws-${randomUUID()}`,
      userId: `market-installer-${tag}`,
    }));
    // In the description of the skills the sort and filter tests walk, and of
    // no other: fixtures added by later tests stay out of their way.
    const pagedQuery = `pg${tag}`;

    type Fixture = {
      name: string;
      id: string;
      versionId: string;
      slug: string;
      verified: boolean;
      installCount: number;
      /** Microseconds since the epoch; null = never listed. */
      listedAtMicros: number | null;
      visibility: "public" | "restricted";
      capability: "prompt-only" | "executable" | null;
      categories: string[];
      listing?: "hidden";
      versionStatus?: "published" | "draft";
      description?: string;
    };
    const fixtures: Fixture[] = [];
    const PUBLIC_COUNT = 23;
    // Three listing moments, so many skills share one — down to the
    // millisecond, where only the microseconds (and then the id) tell them
    // apart. A JS Date cannot hold that, which is what the cursor must survive.
    const LISTED_BASE_MS = [
      Date.parse("2026-03-01T00:00:00.000Z"),
      Date.parse("2026-03-01T00:00:00.001Z"),
      Date.parse("2026-06-15T12:00:00.000Z"),
    ];

    function fixture(input: Partial<Fixture> & { name: string }): Fixture {
      const entry: Fixture = {
        id: randomUUID(),
        versionId: randomUUID(),
        slug: `gh-mkt-${tag}-${input.name}`,
        verified: false,
        installCount: 0,
        listedAtMicros: null,
        visibility: "public",
        capability: "prompt-only",
        categories: [],
        ...input,
      };
      fixtures.push(entry);
      return entry;
    }

    async function insertFixtures(entries: Fixture[]) {
      await data.db.insert(data.skillDefinitions).values(
        entries.map((entry) => ({
          id: entry.id,
          sourceType: "registry_github" as const,
          slug: entry.slug,
          displayName: `Market ${tag} ${entry.slug}`,
          description: entry.description ?? `fixture ${pagedQuery}`,
          visibility: entry.visibility,
          status: "active" as const,
          ownerUserId: owner.userId,
          verified: entry.verified,
        })),
      );
      // Through SQL, not a Date: the microseconds are the point.
      for (const entry of entries) {
        if (entry.listedAtMicros === null) continue;
        await data.db.execute(
          sql`update skill_definitions set listed_at = 'epoch'::timestamptz + ${entry.listedAtMicros}::bigint * interval '1 microsecond' where id = ${entry.id}`,
        );
      }
      await data.db.insert(data.skillVersions).values(
        entries.map((entry) => {
          const status = entry.versionStatus ?? "published";
          return {
            id: entry.versionId,
            skillId: entry.id,
            version: "aaaaaaaaaaaa",
            status,
            storageType: "object" as const,
            skillMd: `---\nname: fixture\ndescription: fixture\n---\nBody of ${entry.slug}\n`,
            bundleSha256: "0".repeat(64),
            bundleObjectKey: `skills/bundles/${"0".repeat(64)}.zip`,
            bundleSizeBytes: 1,
            storagePointer: `github:fixture/skills@${"a".repeat(40)}#${entry.slug}`,
            isCurrent: status === "published",
            contentHash: "hash",
            manifestJson: {
              slug: entry.slug,
              displayName: `Market ${tag} ${entry.slug}`,
              version: "aaaaaaaaaaaa",
              description: entry.description ?? `fixture ${pagedQuery}`,
              visibility: entry.visibility,
              // The author's own, which the market must not show as its own.
              categories: ["self-styled"],
              ...(entry.listing ? { listing: entry.listing } : {}),
              ...(entry.capability
                ? {
                    registry: {
                      identifier: `gh:fixture/skills/${entry.slug}`,
                      sourceUrl: `https://github.com/fixture/skills/tree/${"a".repeat(40)}/${entry.slug}`,
                      repoUrl: "https://github.com/fixture/skills",
                      submittedBy: owner.userId,
                      capability: entry.capability,
                      scan: { reviewRequired: false, flags: [] },
                      fileManifest: [],
                    },
                  }
                : {}),
            },
          };
        }),
      );
      for (const entry of entries)
        for (const installer of installers.slice(0, entry.installCount))
          await skills.upsertWorkspaceSkill({
            ...installer,
            skillId: entry.id,
            skillVersionId: entry.versionId,
            enabled: true,
            enabledBy: installer.userId,
          });
      const filed = entries.flatMap((entry) =>
        entry.categories.map((slug) => ({
          skillId: entry.id,
          categoryId: taxonomy.skillCategoryId(slug),
        })),
      );
      if (filed.length > 0)
        await data.db.insert(data.skillDefinitionCategories).values(filed);
    }

    type Viewer = typeof owner;
    type ListInput = Omit<
      Parameters<typeof service.listCatalog>[0],
      keyof Viewer | "cursor"
    >;
    async function walk(viewer: Viewer, input: ListInput) {
      const pages: string[][] = [];
      let cursor: string | undefined;
      do {
        const page = await service.listCatalog({ ...viewer, ...input, cursor });
        pages.push(
          page.items
            .filter((item) => item.sourceType === "registry_github")
            .map((item) => item.slug),
        );
        cursor = page.nextCursor ?? undefined;
        assert.ok(pages.length < 1000, "paging did not terminate");
      } while (cursor);
      return pages;
    }
    const slugsOf = (entries: Fixture[]) => entries.map((entry) => entry.slug);
    const sorted = (values: string[]) => [...values].sort();
    // The fixtures the paging and filter tests walk, by their default
    // description; what of them a viewer's catalog holds.
    const paged = new Set<string>();
    const visibleTo = (viewer: Viewer) =>
      fixtures.filter(
        (entry) =>
          paged.has(entry.id) &&
          entry.listing !== "hidden" &&
          (entry.visibility === "public" || viewer === owner),
      );

    // What each sort must produce, worked out here from the fixture values
    // rather than read back from the database. `name` is left to PostgreSQL's
    // collation and is only checked for completeness.
    const micros = (entry: Fixture) => entry.listedAtMicros ?? 0;
    const byIdDesc = (a: Fixture, b: Fixture) =>
      a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    const expectedOrder: Record<
      Exclude<SkillCatalogSort, "name">,
      (a: Fixture, b: Fixture) => number
    > = {
      popular: (a, b) => b.installCount - a.installCount || byIdDesc(a, b),
      new: (a, b) => micros(b) - micros(a) || byIdDesc(a, b),
      recommended: (a, b) =>
        Number(b.verified) - Number(a.verified) ||
        b.installCount - a.installCount ||
        micros(b) - micros(a) ||
        byIdDesc(a, b),
    };

    beforeAll(async () => {
      if (
        !new URL(process.env.DATABASE_URL!).pathname.startsWith(
          "/sourceweft_skillv6_",
        )
      )
        throw new Error("Refusing non-isolated database");
      data = await import("@sourceweft/db");
      service = new (await import("../service")).ContentSkillsService();
      skills = await import("../repository");
      rank = await import("./rank");
      taxonomy = await import("./taxonomy");
      await (await import("./listing")).ensureSkillCategories();
      app = new Hono();
      const routes = await import("../../../api/routes/skills-registry");
      const { ApiError, ApiResponse, toApiError } =
        await import("../../../api/response/api-response");
      routes.registerSkillRegistryAdminRoutes(app);
      app.notFound((c) => ApiResponse.error(c, ApiError.notFound()));
      app.onError((error, c) => ApiResponse.error(c, toApiError(error)));

      for (const scope of [owner, stranger, ...installers])
        await data.db.insert(data.workspaces).values({
          id: scope.workspaceId,
          organizationId: scope.teamId,
          name: "Catalog market tests",
          slug: randomUUID(),
        });

      const entries: Fixture[] = [];
      for (let index = 0; index < PUBLIC_COUNT; index += 1) {
        entries.push(
          fixture({
            name: `p${String(index).padStart(2, "0")}`,
            verified: index % 5 === 0,
            // 0..3, so every count is shared by several skills.
            installCount: index % 4,
            // Same millisecond, 0/100/200 µs apart — and exact ties too.
            listedAtMicros:
              LISTED_BASE_MS[index % 3]! * 1000 +
              (index % 4 === 3 ? 0 : (index % 3) * 100),
            capability: index % 2 === 0 ? "executable" : "prompt-only",
            categories:
              index % 6 === 0
                ? ["documents-office", "design-creative"]
                : index % 3 === 0
                  ? ["documents-office"]
                  : [],
          }),
        );
      }
      // Seen by their submitter only, and never listed: NULL `listed_at`.
      for (let index = 0; index < 3; index += 1) {
        entries.push(
          fixture({
            name: `r${index}`,
            visibility: "restricted",
            installCount: index === 0 ? 3 : 0,
            verified: index === 1,
            categories: index === 2 ? ["documents-office"] : [],
          }),
        );
      }
      // Never in any catalog.
      entries.push(
        fixture({ name: "hidden", listing: "hidden", installCount: 3 }),
      );
      for (const entry of entries) paged.add(entry.id);
      await insertFixtures(entries);

      // The stranger's workspace has two of them installed, one switched off
      // — which is still installed, but is not counted as an install.
      for (const name of ["p01", "p02"]) {
        const entry = fixtures.find((f) => f.slug.endsWith(`-${name}`))!;
        await skills.upsertWorkspaceSkill({
          ...stranger,
          skillId: entry.id,
          skillVersionId: entry.versionId,
          enabled: name === "p01",
          enabledBy: stranger.userId,
        });
        if (name === "p01") entry.installCount += 1;
      }
      await (await import("./install-counts")).refreshSkillInstallCounts();
    });

    afterAll(async () => {
      if (!data) return;
      // Versions, categories and installs go with their definition (CASCADE).
      if (fixtures.length > 0)
        await data.db.delete(data.skillDefinitions).where(
          inArray(
            data.skillDefinitions.id,
            fixtures.map((entry) => entry.id),
          ),
        );
      await data.db.delete(data.workspaces).where(
        inArray(
          data.workspaces.id,
          [owner, stranger, ...installers].map((scope) => scope.workspaceId),
        ),
      );
      await data.closeDatabase();
    });

    // --- sorts ----------------------------------------------------------

    for (const sort of ["recommended", "popular", "new", "name"] as const) {
      test(`sort=${sort} pages every visible skill exactly once, NULL listed_at included`, async () => {
        for (const viewer of [owner, stranger]) {
          const expected = visibleTo(viewer);
          const pages = await walk(viewer, {
            limit: 4,
            query: pagedQuery,
            sort,
          });
          const slugs = pages.flat();
          assert.equal(
            new Set(slugs).size,
            slugs.length,
            "a skill was repeated",
          );
          assert.deepEqual(sorted(slugs), sorted(slugsOf(expected)));
          assert.equal(pages.length, Math.ceil(expected.length / 4));
          assert.ok(pages.slice(0, -1).every((page) => page.length === 4));

          // A different page size cuts the same sequence.
          assert.deepEqual(
            (await walk(viewer, { limit: 7, query: pagedQuery, sort })).flat(),
            slugs,
          );
          assert.deepEqual(
            (
              await walk(viewer, { limit: 100, query: pagedQuery, sort })
            ).flat(),
            slugs,
          );
          if (sort !== "name") {
            assert.deepEqual(
              slugs,
              slugsOf([...expected].sort(expectedOrder[sort])),
            );
          }
        }
      });
    }

    test("a never-listed skill sorts after every listed one under sort=new", async () => {
      const slugs = (
        await walk(owner, { limit: 5, query: pagedQuery, sort: "new" })
      ).flat();
      const restricted = slugsOf(
        fixtures.filter(
          (entry) => entry.visibility === "restricted" && paged.has(entry.id),
        ),
      );
      assert.deepEqual(
        sorted(slugs.slice(-restricted.length)),
        sorted(restricted),
      );
    });

    // `rank.ts` is the definition; the ORDER BY is its registry slice.
    test("sort=recommended agrees with the shared ranking", async () => {
      const page = await service.listCatalog({
        ...owner,
        limit: 100,
        query: pagedQuery,
        sort: "recommended",
      });
      const items = page.items.filter(
        (item) => item.sourceType === "registry_github",
      );
      assert.equal(items.length, visibleTo(owner).length);
      for (let index = 1; index < items.length; index += 1) {
        // Same id on both sides: the comparison stops at the last real signal.
        // (An ISO time is to the millisecond; PostgreSQL may order within it.)
        const [before, after] = [items[index - 1]!, items[index]!].map(
          (item) => ({
            skillId: "",
            sourceType: item.sourceType,
            verified: item.verified,
            installCount: item.installCount,
            listedAt: item.listedAt,
          }),
        );
        assert.ok(
          rank.compareRecommendedSkills(before!, after!) <= 0,
          `${items[index - 1]!.slug} is ranked below ${items[index]!.slug}`,
        );
      }
    });

    test("a cursor is good for its own sort only", async () => {
      const first = await service.listCatalog({
        ...stranger,
        limit: 3,
        query: pagedQuery,
        sort: "popular",
      });
      assert.ok(first.nextCursor);
      for (const sort of ["recommended", "new", "name"] as const)
        await assert.rejects(
          service.listCatalog({
            ...stranger,
            limit: 3,
            query: pagedQuery,
            sort,
            cursor: first.nextCursor,
          }),
          (error: { code?: string; statusCode?: number }) =>
            error.code === "INVALID_CURSOR" && error.statusCode === 400,
          sort,
        );
      // No sort given means `recommended`, which this cursor is not for.
      await assert.rejects(
        service.listCatalog({ ...stranger, cursor: first.nextCursor }),
        (error: { code?: string }) => error.code === "INVALID_CURSOR",
      );
    });

    // --- filters ---------------------------------------------------------

    test("category, trust and capability select in SQL, and page under the filter", async () => {
      const publicOnes = visibleTo(stranger);
      const cases: Array<[ListInput["filters"], (entry: Fixture) => boolean]> =
        [
          [
            { category: "documents-office" },
            (e) => e.categories.includes("documents-office"),
          ],
          [
            { category: "design-creative" },
            (e) => e.categories.includes("design-creative"),
          ],
          [{ category: "no-such-category" }, () => false],
          [{ trust: "verified" }, (e) => e.verified],
          [{ trust: "community" }, (e) => !e.verified],
          [{ capability: "executable" }, (e) => e.capability === "executable"],
          [
            { capability: "prompt-only" },
            (e) => e.capability === "prompt-only",
          ],
          [
            {
              category: "documents-office",
              trust: "verified",
              capability: "executable",
            },
            (e) =>
              e.categories.includes("documents-office") &&
              e.verified &&
              e.capability === "executable",
          ],
        ];
      for (const [filters, matches] of cases) {
        const expected = publicOnes.filter(matches);
        const pages = await walk(stranger, {
          limit: 3,
          query: pagedQuery,
          filters,
        });
        assert.deepEqual(
          sorted(pages.flat()),
          sorted(slugsOf(expected)),
          JSON.stringify(filters),
        );
        // A page is `limit` MATCHING skills, not `limit` skills of which some match.
        assert.ok(
          pages.slice(0, -1).every((page) => page.length === 3),
          JSON.stringify(filters),
        );
      }
    });

    test("installed follows this workspace's install rows, enabled or not", async () => {
      const installed = (
        await walk(stranger, {
          limit: 50,
          query: pagedQuery,
          filters: { installed: "installed" },
        })
      ).flat();
      assert.deepEqual(
        sorted(installed),
        sorted([`gh-mkt-${tag}-p01`, `gh-mkt-${tag}-p02`]),
      );
      const notInstalled = (
        await walk(stranger, {
          limit: 50,
          query: pagedQuery,
          filters: { installed: "not_installed" },
        })
      ).flat();
      assert.equal(notInstalled.length, visibleTo(stranger).length - 2);
      assert.ok(!notInstalled.includes(`gh-mkt-${tag}-p01`));
      // Another workspace's installs are not this one's.
      assert.deepEqual(
        (
          await walk(owner, {
            limit: 50,
            query: pagedQuery,
            filters: { installed: "installed" },
          })
        ).flat(),
        [],
      );
    });

    test("trust=builtin is ours alone: no community skill and nothing to page", async () => {
      const page = await service.listCatalog({
        ...stranger,
        filters: { trust: "builtin" },
      });
      assert.equal(page.nextCursor, null);
      assert.ok(page.items.length > 0);
      assert.ok(page.items.every((item) => item.sourceType === "builtin"));
    });

    test("a market filter leaves no builtin or workspace skill on the first page", async () => {
      for (const filters of [
        { category: "documents-office" },
        { trust: "verified" },
        { capability: "prompt-only" },
      ] as const) {
        const page = await service.listCatalog({
          ...stranger,
          limit: 5,
          filters,
        });
        assert.ok(
          page.items.every((item) => item.sourceType === "registry_github"),
          JSON.stringify(filters),
        );
      }
    });

    test("catalog items carry the market's categories, numbers and capability", async () => {
      const page = await service.listCatalog({
        ...stranger,
        limit: 100,
        query: pagedQuery,
      });
      const p00 = page.items.find((item) => item.slug === `gh-mkt-${tag}-p00`)!;
      const entry = fixtures.find((f) => f.slug === p00.slug)!;
      // In the taxonomy's order, and not the manifest's "self-styled".
      assert.deepEqual(p00.categories, ["documents-office", "design-creative"]);
      assert.equal(p00.verified, true);
      assert.equal(p00.installCount, 0);
      assert.equal(p00.capability, "executable");
      assert.equal(
        Date.parse(p00.listedAt!),
        Math.floor(entry.listedAtMicros! / 1000),
      );
      const p01 = page.items.find((item) => item.slug === `gh-mkt-${tag}-p01`)!;
      assert.deepEqual(p01.categories, []);
      assert.equal(p01.verified, false);
      // One installer workspace, and the stranger's own.
      assert.equal(p01.installCount, 2);

      // The detail page's item is the same item.
      const detail = await service.getCatalogSkillDetailBySlug({
        ...stranger,
        slug: p00.slug,
      });
      assert.deepEqual({ ...detail.skill, hasReadme: false }, p00);
    });

    // --- search terms are text, not patterns ----------------------------------

    test("%, _ and \\ in a search are matched literally", async () => {
      const literal = fixture({
        name: "literal",
        description: `100%_done\\ ${tag}`,
        listedAtMicros: LISTED_BASE_MS[0]! * 1000,
      });
      await insertFixtures([literal]);
      const find = async (query: string) =>
        (await walk(stranger, { limit: 100, query })).flat();

      // As wildcards these matched every fixture ("fixture pg<tag>").
      assert.deepEqual(await find(`%${pagedQuery}`), []);
      assert.deepEqual(await find(`fixture_${pagedQuery}`), []);
      assert.equal((await find(`fixture ${pagedQuery}`)).length, PUBLIC_COUNT);
      assert.deepEqual(await find(`100%_done\\ ${tag}`), [literal.slug]);
      assert.deepEqual(await find(`%_done\\ ${tag}`), [literal.slug]);
      assert.deepEqual(await find(`100__done\\ ${tag}`), []);

      // The per-term searches share the query, so they share the escaping.
      const registry = await service.searchRegistry({
        ...stranger,
        query: `fixture_${pagedQuery}`,
      });
      assert.deepEqual(registry.items, []);
      const agent = await service.searchCatalog({
        ...stranger,
        query: `100%_done\\`,
      });
      assert.ok(agent.items.some((item) => item.slug === literal.slug));
      const wildcard = await service.searchCatalog({
        ...stranger,
        query: `__%${tag.slice(0, 2)}%__`,
      });
      assert.ok(!wildcard.items.some((item) => item.slug.includes(tag)));
    });

    test("a search box query matches when every word is somewhere in the entry", async () => {
      const forms = fixture({
        name: "forms",
        description: `Fill in forms inside a PDF ${tag}`,
        listedAtMicros: LISTED_BASE_MS[0]! * 1000,
      });
      await insertFixtures([forms]);
      const find = async (query: string) =>
        (await walk(stranger, { limit: 100, query })).flat();

      // Not a phrase of the description, but both words are in it.
      assert.deepEqual(await find(`pdf forms ${tag}`), [forms.slug]);
      // Every word has to land: one that is nowhere rules the entry out.
      assert.deepEqual(await find(`pdf spreadsheet ${tag}`), []);
    });

    // --- the agent's search ranks by the same trust -----------------------------

    test("search_skills puts a verified skill above a more installed community one", async () => {
      const word = `rankword${tag}`;
      const community = fixture({
        name: "rank-community",
        description: `${word} community`,
        listedAtMicros: LISTED_BASE_MS[2]! * 1000,
      });
      const verified = fixture({
        name: "rank-verified",
        description: `${word} verified`,
        verified: true,
        listedAtMicros: LISTED_BASE_MS[0]! * 1000,
      });
      await insertFixtures([community, verified]);
      await skills.upsertWorkspaceSkill({
        ...owner,
        skillId: community.id,
        skillVersionId: community.versionId,
        enabled: true,
        enabledBy: owner.userId,
      });
      const result = await service.searchCatalog({ ...stranger, query: word });
      assert.deepEqual(
        result.items.map((item) => item.slug),
        [verified.slug, community.slug],
      );
      assert.equal(result.items[0]!.verified, true);
      assert.equal(result.items[1]!.installCount, 1);
    });

    // --- category counts ---------------------------------------------------------

    test("category counts follow what the viewer can see", async () => {
      // Public rows of other suites come and go in these categories, so the
      // exact check is on what ONLY this file's submitter can see: the
      // difference between their counts and a stranger's, taken while the
      // stranger's did not move.
      const mine = [
        fixture({
          name: "c-doc",
          visibility: "restricted",
          categories: ["documents-office"],
        }),
        fixture({
          name: "c-both",
          visibility: "restricted",
          categories: ["documents-office", "data-analytics"],
        }),
        fixture({
          name: "c-hidden",
          visibility: "restricted",
          listing: "hidden",
          categories: ["documents-office"],
        }),
        fixture({
          name: "c-draft",
          visibility: "restricted",
          versionStatus: "draft",
          categories: ["documents-office"],
        }),
      ];
      for (const entry of mine) entry.description = `counts ${tag}`;
      await insertFixtures(mine);

      const counts = async (viewer: Viewer) =>
        new Map(
          (await service.listCatalogCategories(viewer)).items.map((item) => [
            item.slug,
            item.count,
          ]),
        );
      let before = await counts(stranger);
      let own = await counts(owner);
      let after = await counts(stranger);
      for (
        let attempt = 0;
        attempt < 5 &&
        JSON.stringify([...before]) !== JSON.stringify([...after]);
        attempt += 1
      ) {
        before = after;
        own = await counts(owner);
        after = await counts(stranger);
      }
      const delta = (slug: string) => own.get(slug)! - after.get(slug)!;
      // r2, c-doc and c-both; not the hidden one, not the draft-only one.
      assert.equal(delta("documents-office"), 3);
      assert.equal(delta("data-analytics"), 1);
      assert.equal(delta("design-creative"), 0);

      // What is public is counted for everyone.
      const publicDocs = visibleTo(stranger).filter((entry) =>
        entry.categories.includes("documents-office"),
      ).length;
      assert.ok(publicDocs > 0);
      assert.ok(after.get("documents-office")! >= publicDocs);

      // Every category of the taxonomy, in its order, empty ones included.
      const items = (await service.listCatalogCategories(stranger)).items;
      assert.deepEqual(
        items.map((item) => item.slug),
        taxonomy.skillCategoryDefinitions.map((definition) => definition.slug),
      );
      assert.ok(items.every((item) => item.name && item.count >= 0));
    });

    // --- full text ------------------------------------------------------------

    test("a public skill's text is for everyone; a restricted one's is not", async () => {
      const open = fixtures.find((f) => f.slug === `gh-mkt-${tag}-p03`)!;
      const held = fixtures.find((f) => f.slug === `gh-mkt-${tag}-r0`)!;

      // A stranger: no install, not the submitter, not an admin.
      const detail = await service.getCatalogSkillDetailBySlug({
        ...stranger,
        slug: open.slug,
      });
      assert.match(
        detail.skillContent ?? "",
        new RegExp(`Body of ${open.slug}`),
      );
      assert.ok(!("contentRestricted" in detail));
      const version = await service.getRegistryVersionDetail({
        ...stranger,
        catalogId: open.id,
        versionId: open.versionId,
      });
      assert.match(
        version.skillContent ?? "",
        new RegExp(`Body of ${open.slug}`),
      );
      assert.ok(!("contentRestricted" in version));

      // Restricted: its submitter reads it, a stranger does not even find it.
      const mine = await service.getCatalogSkillDetailBySlug({
        ...owner,
        slug: held.slug,
      });
      assert.match(mine.skillContent ?? "", /Body of/);
      await assert.rejects(
        service.getCatalogSkillDetailBySlug({ ...stranger, slug: held.slug }),
        (error: { code?: string }) => error.code === "SKILL_NOT_FOUND",
      );

      // Withdrawn: a workspace that installed the skill still finds the version
      // (its entitlement) and, having it installed, still reads it. For anyone
      // else the text goes with the listing — except the admins who review it.
      const installed = fixtures.find((f) => f.slug === `gh-mkt-${tag}-p01`)!;
      await data.db
        .update(data.skillDefinitions)
        .set({ visibility: "restricted" })
        .where(inArray(data.skillDefinitions.id, [installed.id, open.id]));
      try {
        const kept = await service.getRegistryVersionDetail({
          ...stranger,
          catalogId: installed.id,
          versionId: installed.versionId,
        });
        assert.match(kept.skillContent ?? "", /Body of/);
        await assert.rejects(
          service.getRegistryVersionDetail({
            ...stranger,
            catalogId: open.id,
            versionId: open.versionId,
          }),
        );
        const admin = { ...stranger, userId: adminUserId };
        auth.admins = [adminUserId];
        const reviewed = await service.getRegistryVersionDetail({
          ...admin,
          catalogId: open.id,
          versionId: open.versionId,
        });
        assert.match(reviewed.skillContent ?? "", /Body of/);
      } finally {
        auth.admins = [];
        await data.db
          .update(data.skillDefinitions)
          .set({ visibility: "public" })
          .where(inArray(data.skillDefinitions.id, [installed.id, open.id]));
      }
    });

    // --- admin standing ---------------------------------------------------------

    test("the admin routes move a skill's standing, and the hold cannot be bypassed", async () => {
      const skill = fixture({
        name: "standing",
        visibility: "restricted",
        description: `Create and edit PowerPoint presentations. ${tag}`,
      });
      await insertFixtures([skill]);
      const base = `/v1/skills/registry/admin/skills/${skill.id}`;
      const call = async (path: string, method = "GET", body?: unknown) => {
        const response = await app.request(`${base}${path}`, {
          method,
          ...(body === undefined
            ? {}
            : {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }),
        });
        return {
          status: response.status,
          body: (await response.json()) as Record<string, unknown>,
        };
      };
      const stored = async () => {
        const [row] = await data.db
          .select()
          .from(data.skillDefinitions)
          .where(inArray(data.skillDefinitions.id, [skill.id]));
        return row!;
      };

      auth.userId = stranger.userId;
      auth.admins = [adminUserId];
      assert.equal((await call("/market")).status, 403);
      assert.equal((await call("/list", "POST")).status, 403);
      assert.equal((await stored()).visibility, "restricted");

      auth.userId = adminUserId;
      try {
        const initial = await call("/market");
        assert.equal(initial.status, 200);
        assert.deepEqual(initial.body, {
          skillId: skill.id,
          slug: skill.slug,
          visibility: "restricted",
          listingHold: false,
          listingHoldBy: null,
          verified: false,
          categorySlugs: [],
          installCount: 0,
          listedAt: null,
        });

        const listedOnce = await call("/list", "POST");
        assert.equal(listedOnce.status, 200);
        assert.equal(listedOnce.body.visibility, "public");
        assert.equal(listedOnce.body.listingHold, false);
        assert.equal(typeof listedOnce.body.listedAt, "string");
        // Filed by the classifier on first listing.
        assert.ok(
          (listedOnce.body.categorySlugs as string[]).includes(
            "documents-office",
          ),
        );

        const withdrawn = await call("/delist", "POST");
        assert.equal(withdrawn.status, 200);
        assert.equal(withdrawn.body.visibility, "restricted");
        assert.equal(withdrawn.body.listingHold, true);
        // Held: the auto-listing pass leaves it alone.
        const autoList = await import("./auto-list");
        assert.deepEqual(
          await autoList.listAutoListCandidateIds({ onlySkillIds: [skill.id] }),
          [],
        );

        // Listing by hand lifts the hold, and keeps the first listing's date.
        const relisted = await call("/list", "POST");
        assert.equal(relisted.body.visibility, "public");
        assert.equal(relisted.body.listingHold, false);
        assert.equal(relisted.body.listedAt, listedOnce.body.listedAt);

        // The older visibility route is the same two acts.
        const restricted = await call("/visibility", "PUT", {
          visibility: "restricted",
        });
        assert.equal(restricted.status, 200);
        assert.equal(restricted.body.listingHold, true);
        assert.equal((await stored()).listingHold, true);
        const reopened = await call("/visibility", "PUT", {
          visibility: "public",
        });
        assert.equal(reopened.body.visibility, "public");
        assert.equal(reopened.body.listingHold, false);
        assert.equal((await stored()).listingHold, false);

        const verified = await call("/verified", "PUT", { verified: true });
        assert.equal(verified.status, 200);
        assert.equal(verified.body.verified, true);
        assert.equal((await stored()).verified, true);
        assert.equal(
          (await call("/verified", "PUT", { verified: false })).body.verified,
          false,
        );

        const filed = await call("/categories", "PUT", {
          categorySlugs: ["design-creative", "data-analytics"],
        });
        assert.equal(filed.status, 200);
        assert.deepEqual(sorted(filed.body.categorySlugs as string[]), [
          "data-analytics",
          "design-creative",
        ]);
        const unknown = await call("/categories", "PUT", {
          categorySlugs: ["no-such-category"],
        });
        assert.equal(unknown.status, 400);
        assert.equal(unknown.body.code, "SKILL_CATEGORY_INVALID");
        assert.equal(
          (await call("/verified", "PUT", { verified: "yes" })).status,
          400,
        );

        // Not an active registry skill: nothing to stand anywhere.
        await data.db
          .update(data.skillDefinitions)
          .set({ status: "archived" })
          .where(inArray(data.skillDefinitions.id, [skill.id]));
        for (const [path, method, body] of [
          ["/market", "GET", undefined],
          ["/list", "POST", undefined],
          ["/delist", "POST", undefined],
          ["/verified", "PUT", { verified: true }],
          ["/categories", "PUT", { categorySlugs: ["other"] }],
          ["/visibility", "PUT", { visibility: "public" }],
        ] as const)
          assert.equal((await call(path, method, body)).status, 404, path);
        assert.equal((await stored()).verified, false);
      } finally {
        auth.userId = "";
        auth.admins = [];
      }
    });
  },
);
