import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, test } from "vitest";
import { inArray, sql } from "drizzle-orm";
import {
  getMarketSkillResponseSchema,
  listMarketSkillCategoriesResponseSchema,
  listMarketSkillsResponseSchema,
  type GetMarketSkillResponse,
  type ListMarketSkillCategoriesResponse,
  type ListMarketSkillsResponse,
  type MarketSkillSort,
} from "@sourceweft/market-contracts";

/**
 * The public skill market over HTTP against real PostgreSQL: nobody is signed
 * in, and only what is public and not built in ever comes out — in the list,
 * in the category counts and by slug.
 *
 * Other suites share this database and write public skills of their own while
 * this one runs. The list is scoped by a tag only this file's rows carry; the
 * category counts have no such handle, so they are read as "what is there
 * beyond everyone else's rows" (see `mineIn`).
 */
describe.skipIf(process.env.RUN_SKILL_DB_TESTS !== "1")(
  "public skill market (real PostgreSQL)",
  () => {
    let data: typeof import("@sourceweft/db");
    let skills: typeof import("../repository");
    let taxonomy: typeof import("./taxonomy");
    let listing: typeof import("./listing");
    let app: Hono;

    const tag = randomUUID().slice(0, 8);
    const repoOwner = `pub${tag}`;
    const repoUrl = `https://github.com/${repoOwner}/skills`;
    // In the description of every fixture — the ones that must never show
    // included, so a leak would be found by the very query that scopes the test.
    const word = `pq${tag}`;
    const SHA_NEW = "b".repeat(40);
    const SHA_OLD = "a".repeat(40);
    const secret = `secret-body-${tag}`;

    const installers = [0, 1, 2].map(() => ({
      teamId: `skill-team-${randomUUID()}`,
      workspaceId: `skill-ws-${randomUUID()}`,
      userId: `public-installer-${tag}`,
    }));

    type Fixture = {
      name: string;
      id: string;
      versionId: string;
      slug: string;
      verified: boolean;
      installCount: number;
      /** Microseconds since the epoch; null = no `listed_at`. */
      listedAtMicros: number | null;
      visibility: "public" | "restricted";
      status: "active" | "archived";
      capability: "prompt-only" | "executable" | null;
      license?: string;
      categories: string[];
      listing?: "hidden";
      versionStatus: "published" | "draft" | "deprecated";
      isCurrent: boolean;
      description: string;
      displayName: string;
      flags: string[];
      /** The skill's directory in its repository; "" = the repository root. */
      subpath: string;
    };
    const fixtures: Fixture[] = [];
    const extraSkillIds: string[] = [];

    function fixture(input: Partial<Fixture> & { name: string }): Fixture {
      const slug = `gh-${repoOwner}-skills-${input.name}`;
      const entry: Fixture = {
        id: randomUUID(),
        versionId: randomUUID(),
        slug,
        verified: false,
        installCount: 0,
        listedAtMicros: Date.parse("2026-05-01T00:00:00.000Z") * 1000,
        visibility: "public",
        status: "active",
        capability: "prompt-only",
        categories: [],
        versionStatus: "published",
        isCurrent: true,
        description: `fixture ${word}`,
        displayName: `Public ${tag} ${input.name}`,
        flags: [],
        subpath: input.name,
        ...input,
      };
      fixtures.push(entry);
      return entry;
    }

    function manifestOf(entry: Fixture, sha = SHA_NEW) {
      return {
        slug: entry.slug,
        displayName: entry.displayName,
        version: sha.slice(0, 12),
        description: entry.description,
        visibility: entry.visibility,
        // The author's own, which the market must not show as its own.
        categories: ["self-styled"],
        ...(entry.listing ? { listing: entry.listing } : {}),
        ...(entry.capability
          ? {
              registry: {
                identifier: `gh:${repoOwner}/skills/${entry.name}`,
                sourceUrl: `${repoUrl}/tree/${sha}/${entry.subpath}`,
                repoUrl,
                submittedBy: "public-owner",
                committedAt: "2026-04-30T12:00:00.000Z",
                // What ingest stamps: the commit is the repository's own.
                provenance: {
                  defaultBranch: "main",
                  checkedAt: "2026-04-30T12:00:00.000Z",
                },
                capability: entry.capability,
                scan: { reviewRequired: false, flags: entry.flags },
                ...(entry.license ? { license: entry.license } : {}),
                fileManifest: [
                  {
                    path: "SKILL.md",
                    sha256: "0".repeat(64),
                    sizeBytes: 42,
                    role: "model-readable" as const,
                  },
                ],
              },
            }
          : {}),
      };
    }

    function versionRow(
      entry: Fixture,
      overrides: Partial<{
        id: string;
        sha: string;
        status: Fixture["versionStatus"];
        isCurrent: boolean;
        createdAt: Date;
        skillMd: string | null;
        storageType: "object" | "db_text";
      }> = {},
    ) {
      const sha = overrides.sha ?? SHA_NEW;
      const status = overrides.status ?? entry.versionStatus;
      const storageType = overrides.storageType ?? "object";
      return {
        id: overrides.id ?? entry.versionId,
        skillId: entry.id,
        version: sha.slice(0, 12),
        status,
        storageType,
        skillMd:
          overrides.skillMd === undefined
            ? `---\nname: ${entry.name}\ndescription: fixture\n---\nBody of ${entry.slug}\n`
            : overrides.skillMd,
        ...(storageType === "object"
          ? {
              bundleSha256: "0".repeat(64),
              bundleObjectKey: `skills/bundles/${"0".repeat(64)}.zip`,
              bundleSizeBytes: 1,
            }
          : {}),
        // As the registry writes it: no `#` for a skill at the repository root.
        storagePointer: `github:${repoOwner}/skills@${sha}${
          entry.subpath ? `#${entry.subpath}` : ""
        }`,
        isCurrent: overrides.isCurrent ?? entry.isCurrent,
        contentHash: "hash",
        publishedAt:
          status === "draft" ? null : new Date("2026-05-02T00:00:00.000Z"),
        createdAt: overrides.createdAt ?? new Date("2026-05-02T00:00:00.000Z"),
        manifestJson: manifestOf(entry, sha),
      };
    }

    async function insertFixtures(entries: Fixture[]) {
      await data.db.insert(data.skillDefinitions).values(
        entries.map((entry) => ({
          id: entry.id,
          sourceType: "registry_github" as const,
          slug: entry.slug,
          displayName: entry.displayName,
          description: entry.description,
          visibility: entry.visibility,
          status: entry.status,
          ownerUserId: "public-owner",
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
      await data.db
        .insert(data.skillVersions)
        .values(entries.map((entry) => versionRow(entry)));
      // Real installs: `install_count` is refreshed from the install rows, by
      // other suites too, so a count a fixture merely claimed would not last.
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

    // --- HTTP ---------------------------------------------------------------

    async function getJson<T>(path: string, status = 200): Promise<T> {
      const response = await app.request(path);
      assert.equal(response.status, status, path);
      // No route here knows a caller, so none may vary on one.
      if (status === 200)
        assert.equal(response.headers.get("cache-control"), "public, max-age=60");
      return (await response.json()) as T;
    }

    async function list(params: Record<string, string | number | boolean>) {
      const search = new URLSearchParams(
        Object.entries(params).map(([key, value]) => [key, String(value)]),
      );
      const body = await getJson<ListMarketSkillsResponse>(`/v1/skills?${search}`);
      // Strict: a field the contract does not name must not be on the wire.
      listMarketSkillsResponseSchema.strict().parse(body);
      return body;
    }

    async function walk(params: Record<string, string | number | boolean>) {
      const pages: string[][] = [];
      let cursor: string | undefined;
      do {
        const page = await list({ ...params, ...(cursor ? { cursor } : {}) });
        pages.push(page.items.map((item) => item.slug));
        cursor = page.nextCursor ?? undefined;
        assert.ok(pages.length < 1000, "paging did not terminate");
      } while (cursor);
      return pages;
    }

    const detail = (slug: string) =>
      getJson<GetMarketSkillResponse>(`/v1/skills/${slug}`);
    const categories = () =>
      getJson<ListMarketSkillCategoriesResponse>("/v1/skills/categories");

    /**
     * How many public skills that are NOT this file's the database holds, in a
     * category or in all — worked out in plain SQL, apart from the code under
     * test.
     */
    async function foreignPublic(category: string | null): Promise<number> {
      const result = await data.db.execute(sql`
        select count(distinct d.id)::int as n
        from skill_definitions d
        join skill_versions v on v.skill_id = d.id
        where d.visibility = 'public' and d.source_type <> 'builtin'
          and d.status = 'active' and v.status = 'published' and v.is_current
          and coalesce(v.manifest_json->>'listing', '') <> 'hidden'
          and d.slug not like ${`%${tag}%`}
          and (${category}::text is null or exists (
            select 1 from skill_definition_categories dc
            join skill_categories c on c.id = dc.category_id
            where dc.skill_id = d.id and c.slug = ${category}::text))`);
      const rows = (result as unknown as { rows?: Array<{ n: number }> }).rows ??
        (result as unknown as Array<{ n: number }>);
      return Number(rows[0]!.n);
    }

    /**
     * This file's share of the category counts: what the API reports less
     * everyone else's rows. Other suites add and remove public skills while
     * this runs, so a reading only counts if their rows held still around it.
     */
    async function mineIn(): Promise<{
      total: number;
      byCategory: Map<string, number>;
      body: ListMarketSkillCategoriesResponse;
    }> {
      const slugs = taxonomy.skillCategoryDefinitions.map((c) => c.slug);
      const measure = async () =>
        Promise.all([null, ...slugs].map((slug) => foreignPublic(slug)));
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const before = await measure();
        const body = await categories();
        const after = await measure();
        if (before.join() !== after.join()) continue;
        return {
          body,
          total: body.total - before[0]!,
          byCategory: new Map(
            body.items.map((item, index) => [
              item.slug,
              item.count - before[index + 1]!,
            ]),
          ),
        };
      }
      throw new Error("other suites never held still");
    }

    const bySlugName = (name: string) =>
      fixtures.find((entry) => entry.name === name)!;
    const slugsOf = (entries: Fixture[]) => entries.map((entry) => entry.slug);
    const sorted = (values: string[]) => [...values].sort();
    const isPublic = (entry: Fixture) =>
      entry.visibility === "public" &&
      entry.status === "active" &&
      entry.versionStatus === "published" &&
      entry.isCurrent &&
      entry.listing !== "hidden";
    // The rows of `beforeAll`, which the sort and filter tests walk; later
    // tests add fixtures under other words.
    const paged = new Set<string>();
    const expectedPublic = () =>
      fixtures.filter((entry) => paged.has(entry.id) && isPublic(entry));

    const micros = (entry: Fixture) => entry.listedAtMicros ?? 0;
    const byIdDesc = (a: Fixture, b: Fixture) =>
      a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    const expectedOrder: Record<
      Exclude<MarketSkillSort, "name">,
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

    const PUBLIC_COUNT = 17;
    const LISTED_BASE_MS = [
      Date.parse("2026-03-01T00:00:00.000Z"),
      Date.parse("2026-03-01T00:00:00.001Z"),
      Date.parse("2026-06-15T12:00:00.000Z"),
    ];
    const builtinSlug = `builtin-${tag}-${word}`;

    beforeAll(async () => {
      if (
        !new URL(process.env.DATABASE_URL!).pathname.startsWith(
          "/sourceweft_skillv6_",
        )
      )
        throw new Error("Refusing non-isolated database");
      data = await import("@sourceweft/db");
      skills = await import("../repository");
      taxonomy = await import("./taxonomy");
      listing = await import("./listing");
      await listing.ensureSkillCategories();

      app = new Hono();
      const routes = await import("../../../api/routes/skills-public");
      const { ApiError, ApiResponse, toApiError } =
        await import("../../../api/response/api-response");
      routes.registerSkillPublicRoutes(app);
      app.notFound((c) => ApiResponse.error(c, ApiError.notFound()));
      app.onError((error, c) => ApiResponse.error(c, toApiError(error)));

      for (const scope of installers)
        await data.db.insert(data.workspaces).values({
          id: scope.workspaceId,
          organizationId: scope.teamId,
          name: "Public market tests",
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
            // Same millisecond, 0/100/200 µs apart — and exact ties too. One
            // public skill has no `listed_at` at all.
            listedAtMicros:
              index === 16
                ? null
                : LISTED_BASE_MS[index % 3]! * 1000 +
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
      // Everything below must never come out. Each is popular, verified and
      // filed under a category, so it would lead any page it leaked into.
      const never = {
        installCount: 3,
        verified: true,
        categories: ["documents-office"],
      };
      entries.push(
        fixture({ ...never, name: "restricted", visibility: "restricted" }),
        fixture({ ...never, name: "archived", status: "archived" }),
        fixture({ ...never, name: "hidden", listing: "hidden" }),
        fixture({ ...never, name: "draftcurrent", versionStatus: "draft" }),
        fixture({ ...never, name: "deprecated", versionStatus: "deprecated" }),
        // Published, but not the current version — and nothing else is.
        fixture({ ...never, name: "nocurrent", isCurrent: false }),
      );
      for (const entry of entries) paged.add(entry.id);
      await insertFixtures(entries);

      // A builtin is public by visibility and still not the market's to show.
      const builtin = await skills.syncBuiltinSkillMetadata({
        slug: builtinSlug,
        displayName: `Builtin ${tag}`,
        description: `fixture ${word}`,
        visibility: "public",
        version: "1.0.0",
        storagePointer: `builtin:${builtinSlug}`,
        contentHash: "hash",
        manifestJson: {
          slug: builtinSlug,
          displayName: `Builtin ${tag}`,
          version: "1.0.0",
          description: `fixture ${word}`,
          visibility: "public",
          categories: [],
        },
      });
      const builtinId = builtin.id;
      extraSkillIds.push(builtinId);
      await data.db.insert(data.skillDefinitionCategories).values({
        skillId: builtinId,
        categoryId: taxonomy.skillCategoryId("documents-office"),
      });

      await (await import("./install-counts")).refreshSkillInstallCounts();
    });

    afterAll(async () => {
      if (!data) return;
      // Versions, files, categories and installs go with their definition.
      const ids = [...fixtures.map((entry) => entry.id), ...extraSkillIds];
      if (ids.length > 0)
        await data.db
          .delete(data.skillDefinitions)
          .where(inArray(data.skillDefinitions.id, ids));
      await data.db.delete(data.workspaces).where(
        inArray(
          data.workspaces.id,
          installers.map((scope) => scope.workspaceId),
        ),
      );
      await data.closeDatabase();
    });

    // --- the predicate ------------------------------------------------------

    test("the fixtures are what they claim: the builtin really is a public, active, published row", async () => {
      const result = await data.db.execute(sql`
        select d.visibility, d.status, d.source_type, v.status as version_status, v.is_current
        from skill_definitions d join skill_versions v on v.skill_id = d.id
        where d.slug = ${builtinSlug}`);
      const rows = (result as unknown as { rows?: unknown[] }).rows ??
        (result as unknown as unknown[]);
      assert.deepEqual(rows, [
        {
          visibility: "public",
          status: "active",
          source_type: "builtin",
          version_status: "published",
          is_current: true,
        },
      ]);
    });

    test("the list never holds a restricted, builtin, archived, unpublished or hidden skill", async () => {
      for (const sort of ["recommended", "popular", "new", "name"] as const) {
        const slugs = (await walk({ query: word, sort, limit: 100 })).flat();
        assert.deepEqual(sorted(slugs), sorted(slugsOf(expectedPublic())), sort);
      }
      // Nor by asking for exactly what they are.
      for (const name of [
        "restricted",
        "archived",
        "hidden",
        "draftcurrent",
        "deprecated",
        "nocurrent",
      ]) {
        const page = await list({ query: `${tag} ${name}` });
        assert.deepEqual(page.items, [], name);
      }
      assert.deepEqual((await list({ query: builtinSlug })).items, []);
      assert.deepEqual(
        (await list({ query: word, verified: true, category: "documents-office" }))
          .items.map((item) => item.slug)
          .sort(),
        sorted(
          slugsOf(
            expectedPublic().filter(
              (entry) =>
                entry.verified && entry.categories.includes("documents-office"),
            ),
          ),
        ),
      );
    });

    test("by slug, everything that is not public is the same 404", async () => {
      for (const slug of [
        ...[
          "restricted",
          "archived",
          "hidden",
          "draftcurrent",
          "deprecated",
          "nocurrent",
        ].map((name) => bySlugName(name).slug),
        builtinSlug,
        `gh-${repoOwner}-skills-nobody-has-this`,
        "registry",
      ]) {
        const body = await getJson<{ code: string; message: string }>(
          `/v1/skills/${slug}`,
          404,
        );
        assert.deepEqual(body, { code: "NOT_FOUND", message: "Skill not found" }, slug);
      }
    });

    test("category counts hold public skills only, each skill once in the total", async () => {
      const mine = await mineIn();
      listMarketSkillCategoriesResponseSchema.strict().parse(mine.body);
      // Every category, in taxonomy order, whether or not anything is in it.
      assert.deepEqual(
        mine.body.items.map((item) => item.slug),
        taxonomy.skillCategoryDefinitions.map((definition) => definition.slug),
      );
      const expected = expectedPublic();
      assert.equal(mine.total, expected.length);
      for (const definition of taxonomy.skillCategoryDefinitions) {
        assert.equal(
          mine.byCategory.get(definition.slug),
          expected.filter((entry) => entry.categories.includes(definition.slug))
            .length,
          definition.slug,
        );
      }
      // Two categories share skills, so the counts add up past the total's
      // share of them — the total is not their sum.
      assert.ok(
        mine.byCategory.get("documents-office")! +
          mine.byCategory.get("design-creative")! >
          expected.filter((entry) => entry.categories.length > 0).length,
      );
    });

    // --- sorts --------------------------------------------------------------

    for (const sort of ["recommended", "popular", "new", "name"] as const) {
      test(`sort=${sort} pages every public skill exactly once, in order`, async () => {
        const expected = expectedPublic();
        const pages = await walk({ query: word, sort, limit: 4 });
        const slugs = pages.flat();
        assert.equal(new Set(slugs).size, slugs.length, "a skill repeated");
        assert.deepEqual(sorted(slugs), sorted(slugsOf(expected)));
        assert.equal(pages.length, Math.ceil(expected.length / 4));
        assert.ok(pages.slice(0, -1).every((page) => page.length === 4));
        if (sort !== "name") {
          assert.deepEqual(
            slugs,
            slugsOf([...expected].sort(expectedOrder[sort])),
          );
        }
      });
    }

    test("recommended is the default sort, and 24 the default page", async () => {
      const bare = await list({ query: word });
      const named = await list({ query: word, sort: "recommended" });
      assert.deepEqual(bare, named);
      // 17 public fixtures fit in one default page.
      assert.equal(bare.items.length, expectedPublic().length);
      assert.equal(bare.nextCursor, null);
    });

    test("a cursor is good for its own sort only; nonsense is refused too", async () => {
      const page = await list({ query: word, sort: "popular", limit: 2 });
      assert.ok(page.nextCursor);
      for (const cursor of [page.nextCursor!, "bm9uc2Vuc2U"]) {
        const body = await getJson<{ code: string }>(
          `/v1/skills?sort=new&cursor=${encodeURIComponent(cursor)}`,
          400,
        );
        assert.equal(body.code, "INVALID_CURSOR");
      }
    });

    // --- filters ------------------------------------------------------------

    test("category, verified and capability select in SQL, alone and together", async () => {
      const expected = expectedPublic();
      const cases: Array<
        [Record<string, string | boolean>, (entry: Fixture) => boolean]
      > = [
        [{ category: "documents-office" }, (e) => e.categories.includes("documents-office")],
        [{ category: "design-creative" }, (e) => e.categories.includes("design-creative")],
        [{ category: "no-such-category" }, () => false],
        [{ verified: true }, (e) => e.verified],
        [{ verified: false }, (e) => !e.verified],
        [{ capability: "executable" }, (e) => e.capability === "executable"],
        [{ capability: "prompt-only" }, (e) => e.capability === "prompt-only"],
        [
          { category: "documents-office", verified: false, capability: "prompt-only" },
          (e) =>
            e.categories.includes("documents-office") &&
            !e.verified &&
            e.capability === "prompt-only",
        ],
      ];
      for (const [params, matches] of cases) {
        // Small pages: a filter applied after the page was cut would show up
        // as short pages and a walk that ends early.
        const pages = await walk({ query: word, limit: 3, ...params });
        assert.deepEqual(
          sorted(pages.flat()),
          sorted(slugsOf(expected.filter(matches))),
          JSON.stringify(params),
        );
        assert.ok(
          pages.slice(0, -1).every((page) => page.length === 3),
          JSON.stringify(params),
        );
      }
    });

    test("every word of a query must match, across slug, name and description; LIKE syntax is literal", async () => {
      const entries = [
        fixture({
          name: "formfiller",
          description: `Fill in forms in a PDF sq${tag}`,
          displayName: `Form helper sq${tag}`,
        }),
        fixture({
          name: "percent",
          description: `Gives 100% of the a_b it has sq${tag}`,
        }),
        fixture({ name: "plain", description: `Nothing special 100 axb sq${tag}` }),
      ];
      await insertFixtures(entries);
      const find = async (query: string) =>
        sorted((await list({ query })).items.map((item) => item.slug));
      const [formfiller, percent, plain] = entries.map((entry) => entry.slug);

      assert.deepEqual(await find(`sq${tag}`), sorted([formfiller!, percent!, plain!]));
      // Words from the description and the display name, in any order, any case.
      assert.deepEqual(await find(`PDF, helper sq${tag}`), [formfiller]);
      // One word from the slug, one from the description.
      assert.deepEqual(await find(`formfiller pdf`), [formfiller]);
      assert.deepEqual(await find(`sq${tag} forms missingword`), []);
      // `%` and `_` are characters to find, not wildcards.
      assert.deepEqual(await find(`sq${tag} 100%`), [percent]);
      assert.deepEqual(await find(`sq${tag} a_b`), [percent]);
    });

    // --- summary ------------------------------------------------------------

    test("a summary carries the market's facts", async () => {
      const entry = bySlugName("p06");
      const page = await list({ query: `${word} p06` });
      assert.equal(page.items.length, 1);
      assert.deepEqual(page.items[0], {
        slug: entry.slug,
        name: "p06",
        displayName: entry.displayName,
        description: entry.description,
        // No logo of its own: the publisher's avatar stands in.
        logo: {
          url: `https://github.com/${repoOwner}.png?size=128`,
          source: "publisher",
        },
        categories: ["documents-office", "design-creative"].sort(
          (a, b) =>
            taxonomy.skillCategoryDefinitions.findIndex((c) => c.slug === a) -
            taxonomy.skillCategoryDefinitions.findIndex((c) => c.slug === b),
        ),
        verified: false,
        capability: "executable",
        license: null,
        author: repoOwner,
        repoUrl,
        sourceUrl: `${repoUrl}/tree/${SHA_NEW}/p06`,
        installCount: 2,
        listedAt: new Date(LISTED_BASE_MS[0]!).toISOString(),
        version: SHA_NEW.slice(0, 12),
        updatedAt: "2026-05-02T00:00:00.000Z",
      });
    });

    test("a public skill with no listing date reports the day it was created", async () => {
      const entry = bySlugName("p16");
      const { skill } = await detail(entry.slug);
      const [row] = await data.db
        .select({ createdAt: data.skillDefinitions.createdAt })
        .from(data.skillDefinitions)
        .where(sql`${data.skillDefinitions.id} = ${entry.id}`);
      assert.equal(skill.listedAt, row!.createdAt.toISOString());
    });

    // --- detail -------------------------------------------------------------

    test("the detail carries SKILL.md, a manifest without contents, and published versions newest first", async () => {
      const entry = fixture({
        name: "detailed",
        description: `detail dq${tag}`,
        license: "Apache-2.0",
        capability: "executable",
        flags: ["binary:executable"],
        categories: ["documents-office"],
        isCurrent: true,
        subpath: "document-skills/detailed",
      });
      await insertFixtures([entry]);
      const older = randomUUID();
      const draft = randomUUID();
      await data.db.insert(data.skillVersions).values([
        versionRow(entry, {
          id: older,
          sha: SHA_OLD,
          status: "published",
          isCurrent: false,
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
        }),
        // Newer than both, and nobody's business: a draft awaiting review.
        versionRow(entry, {
          id: draft,
          sha: "c".repeat(40),
          status: "draft",
          isCurrent: false,
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
        }),
      ]);
      const hashOf = (digit: string) => digit.repeat(64);
      await data.db.insert(data.skillVersionFiles).values([
        {
          id: randomUUID(),
          skillVersionId: entry.versionId,
          path: "SKILL.md",
          objectKey: `skills/blobs/${hashOf("1")}`,
          mimeType: "text/markdown",
          sizeBytes: 64,
          contentHash: hashOf("1"),
        },
        {
          id: randomUUID(),
          skillVersionId: entry.versionId,
          path: "scripts/run.py",
          contentText: `print("${secret}")`,
          mimeType: "text/x-python",
          sizeBytes: 30,
          // Stored the long way round; the wire form is bare lowercase hex.
          contentHash: `sha256:${hashOf("e").toUpperCase()}`,
        },
        // A binary is part of the manifest like anything else.
        {
          id: randomUUID(),
          skillVersionId: entry.versionId,
          path: "bin/tool",
          objectKey: `skills/blobs/${hashOf("5")}`,
          mimeType: "application/octet-stream",
          sizeBytes: 9000,
          contentHash: hashOf("5"),
        },
        // Another version's file is not this version's.
        {
          id: randomUUID(),
          skillVersionId: older,
          path: "old-only.txt",
          contentText: secret,
          mimeType: "text/plain",
          sizeBytes: 5,
          contentHash: hashOf("3"),
        },
      ]);

      const response = await app.request(`/v1/skills/${entry.slug}`);
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.ok(!text.includes(secret), "a file's contents went out");
      const body = getMarketSkillResponseSchema
        .strict()
        .parse(JSON.parse(text));

      assert.equal(
        body.skillMd,
        `---\nname: detailed\ndescription: fixture\n---\nBody of ${entry.slug}\n`,
      );
      // The complete manifest of the current version, as the database has
      // it: every path, each with the hash recorded for it.
      const stored = await data.db
        .select({
          path: data.skillVersionFiles.path,
          sizeBytes: data.skillVersionFiles.sizeBytes,
          mimeType: data.skillVersionFiles.mimeType,
          contentHash: data.skillVersionFiles.contentHash,
        })
        .from(data.skillVersionFiles)
        .where(sql`${data.skillVersionFiles.skillVersionId} = ${entry.versionId}`);
      assert.equal(stored.length, 3);
      const byPath = (a: { path: string }, b: { path: string }) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
      assert.deepEqual(
        [...body.files].sort(byPath),
        stored
          .map((file) => ({
            ...file,
            contentHash: file.contentHash.replace(/^sha256:/, "").toLowerCase(),
          }))
          .sort(byPath),
      );
      assert.deepEqual(
        Object.fromEntries(body.files.map((f) => [f.path, f.contentHash])),
        {
          "SKILL.md": hashOf("1"),
          "bin/tool": hashOf("5"),
          "scripts/run.py": hashOf("e"),
        },
      );
      assert.deepEqual(body.versions, [
        {
          version: SHA_NEW.slice(0, 12),
          isCurrent: true,
          publishedAt: "2026-05-02T00:00:00.000Z",
          commitSha: SHA_NEW,
          committedAt: "2026-04-30T12:00:00.000Z",
        },
        {
          version: SHA_OLD.slice(0, 12),
          isCurrent: false,
          publishedAt: "2026-05-02T00:00:00.000Z",
          commitSha: SHA_OLD,
          committedAt: "2026-04-30T12:00:00.000Z",
        },
      ]);
      assert.deepEqual(body.source, {
        repoUrl,
        sourceUrl: `${repoUrl}/tree/${SHA_NEW}/document-skills/detailed`,
        commitSha: SHA_NEW,
        committedAt: "2026-04-30T12:00:00.000Z",
        repoSubpath: "document-skills/detailed",
      });
      assert.deepEqual(body.scanFlags, ["binary:executable"]);
      assert.equal(body.skill.license, "Apache-2.0");
      assert.equal(body.skill.name, "detailed");
      assert.deepEqual(body.skill.categories, ["documents-office"]);
      // The same summary the list gives.
      const [listed] = (await list({ query: `dq${tag}` })).items;
      assert.deepEqual(body.skill, listed);
    });

    test("SKILL.md kept as an inline file row is served; a version with no file rows lists its manifest", async () => {
      const inline = fixture({ name: "inline", description: `detail iq${tag}` });
      // A skill that is its whole repository.
      const bare = fixture({
        name: "bare",
        description: `detail iq${tag}`,
        subpath: "",
      });
      await data.db.insert(data.skillDefinitions).values(
        [inline, bare].map((entry) => ({
          id: entry.id,
          sourceType: "registry_github" as const,
          slug: entry.slug,
          displayName: entry.displayName,
          description: entry.description,
          visibility: "public" as const,
          status: "active" as const,
          listedAt: new Date(),
        })),
      );
      await data.db.insert(data.skillVersions).values([
        versionRow(inline, { skillMd: null, storageType: "db_text" }),
        versionRow(bare),
      ]);
      await data.db.insert(data.skillVersionFiles).values({
        id: randomUUID(),
        skillVersionId: inline.versionId,
        path: "SKILL.md",
        contentText: "---\nname: inline\n---\nInline body\n",
        mimeType: "text/markdown",
        sizeBytes: 33,
        contentHash: "4".repeat(64),
      });

      const inlineBody = await detail(inline.slug);
      assert.equal(inlineBody.skillMd, "---\nname: inline\n---\nInline body\n");
      assert.deepEqual(inlineBody.files, [
        {
          path: "SKILL.md",
          sizeBytes: 33,
          mimeType: "text/markdown",
          contentHash: "4".repeat(64),
        },
      ]);
      assert.equal(inlineBody.source.repoSubpath, "inline");

      const bareBody = await detail(bare.slug);
      assert.deepEqual(bareBody.files, [
        {
          path: "SKILL.md",
          sizeBytes: 42,
          mimeType: null,
          contentHash: "0".repeat(64),
        },
      ]);
      assert.equal(bareBody.source.repoSubpath, "");
      assert.equal(bareBody.source.commitSha, SHA_NEW);
    });

    // --- listing and delisting ---------------------------------------------

    test("a skill appears when it is listed and is gone — list, counts, slug — when it is delisted", async () => {
      const entry = fixture({
        name: "lifecycle",
        description: `lifecycle lq${tag}`,
        visibility: "restricted",
        listedAtMicros: null,
        categories: ["design-creative"],
      });
      await insertFixtures([entry]);
      const before = await mineIn();
      await getJson(`/v1/skills/${entry.slug}`, 404);
      assert.deepEqual((await list({ query: `lq${tag}` })).items, []);

      await listing.listSkillPublicly({
        skillId: entry.id,
        actorUserId: "public-admin",
      });
      const listed = await mineIn();
      assert.equal(listed.total, before.total + 1);
      assert.equal(
        listed.byCategory.get("design-creative"),
        before.byCategory.get("design-creative")! + 1,
      );
      const [item] = (await list({ query: `lq${tag}` })).items;
      assert.equal(item?.slug, entry.slug);
      assert.ok(Date.now() - Date.parse(item!.listedAt) < 60_000);
      assert.equal((await detail(entry.slug)).skill.slug, entry.slug);

      await listing.delistSkill({
        skillId: entry.id,
        actorUserId: "public-admin",
      });
      const body = await getJson<{ code: string }>(
        `/v1/skills/${entry.slug}`,
        404,
      );
      assert.equal(body.code, "NOT_FOUND");
      assert.deepEqual((await list({ query: `lq${tag}` })).items, []);
      const delisted = await mineIn();
      assert.equal(delisted.total, before.total);
      assert.equal(
        delisted.byCategory.get("design-creative"),
        before.byCategory.get("design-creative"),
      );
    });
  },
);
