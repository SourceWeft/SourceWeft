import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, test } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  getMarketSkillCollectionResponseSchema,
  getMarketSkillResponseSchema,
  listMarketSkillCollectionsResponseSchema,
  listMarketSkillsResponseSchema,
  type GetMarketSkillResponse,
  type ListMarketSkillsResponse,
} from "@sourceweft/market-contracts";

/**
 * The market's discovery layer against real PostgreSQL: the rank-score and
 * stars sorts, exact totals, related skills, editorial collections, the
 * listing queue's second kind of entry (a public skill whose new version adds
 * flags or scripts), and the GitHub repository refresh.
 *
 * The database is shared with other suites, so every assertion is scoped to
 * rows this file made: a word only its fixtures carry, its own repositories.
 */
describe.skipIf(process.env.RUN_SKILL_DB_TESTS !== "1")(
  "skill market discovery (real PostgreSQL)",
  () => {
    let data: typeof import("@sourceweft/db");
    let rank: typeof import("./rank");
    let installCounts: typeof import("./install-counts");
    let autoList: typeof import("./auto-list");
    let collections: typeof import("./collections");
    let repoMetadata: typeof import("./repo-metadata");
    let taxonomy: typeof import("./taxonomy");
    let service: import("../service").ContentSkillsService;
    let app: Hono;

    const tag = randomUUID().slice(0, 8);
    const word = `dq${tag}`;
    const owner = `disc${tag}`;
    const SHA_OLD = "a".repeat(40);
    const SHA_NEW = "b".repeat(40);
    const skillIds: string[] = [];
    const collectionIds: string[] = [];

    type Fixture = {
      id: string;
      versionId: string;
      name: string;
      slug: string;
      repo: string;
      visibility: "public" | "restricted";
      verified: boolean;
      stars: number;
      listedAt: Date;
      categories: string[];
    };

    function manifest(
      entry: Fixture,
      sha: string,
      options: { flags?: string[]; scripts?: string[] } = {},
    ) {
      return {
        slug: entry.slug,
        displayName: `Discovery ${tag} ${entry.name}`,
        version: sha.slice(0, 12),
        description: `fixture ${word}`,
        visibility: entry.visibility,
        categories: [],
        registry: {
          identifier: `gh:${owner}/${entry.repo}/${entry.name}`,
          sourceUrl: `https://github.com/${owner}/${entry.repo}/tree/${sha}/${entry.name}`,
          repoUrl: `https://github.com/${owner}/${entry.repo}`,
          submittedBy: "discovery-owner",
          committedAt: "2026-04-30T12:00:00.000Z",
          provenance: {
            defaultBranch: "main",
            checkedAt: "2026-04-30T12:00:00.000Z",
          },
          capability: (options.scripts?.length
            ? "executable"
            : "prompt-only") as "executable" | "prompt-only",
          scan: { reviewRequired: false, flags: options.flags ?? [] },
          fileManifest: [
            {
              path: "SKILL.md",
              sha256: "0".repeat(64),
              sizeBytes: 42,
              role: "model-readable" as const,
            },
            ...(options.scripts ?? []).map((path) => ({
              path,
              sha256: "1".repeat(64),
              sizeBytes: 10,
              role: "script" as const,
            })),
          ],
        },
      };
    }

    function versionRow(
      entry: Fixture,
      input: {
        id: string;
        sha: string;
        isCurrent: boolean;
        createdAt: Date;
        flags?: string[];
        scripts?: string[];
      },
    ) {
      return {
        id: input.id,
        skillId: entry.id,
        version: input.sha.slice(0, 12),
        status: "published" as const,
        storageType: "object" as const,
        skillMd: `---\nname: ${entry.name}\n---\nBody\n`,
        bundleSha256: "0".repeat(64),
        bundleObjectKey: `skills/bundles/${"0".repeat(64)}.zip`,
        bundleSizeBytes: 1,
        storagePointer: `github:${owner}/${entry.repo}@${input.sha}#${entry.name}`,
        isCurrent: input.isCurrent,
        contentHash: "hash",
        publishedAt: input.createdAt,
        createdAt: input.createdAt,
        manifestJson: manifest(entry, input.sha, input),
      };
    }

    function fixture(input: Partial<Fixture> & { name: string }): Fixture {
      return {
        id: randomUUID(),
        versionId: randomUUID(),
        slug: `gh-${owner}-${input.repo ?? "main"}-${input.name}`,
        repo: "main",
        visibility: "public",
        verified: false,
        stars: 0,
        listedAt: new Date("2026-05-01T00:00:00.000Z"),
        categories: [],
        ...input,
      };
    }

    /** One definition with one current published version at SHA_NEW. */
    async function insert(entries: Fixture[]) {
      for (const entry of entries) skillIds.push(entry.id);
      await data.db.insert(data.skillDefinitions).values(
        entries.map((entry) => ({
          id: entry.id,
          sourceType: "registry_github" as const,
          slug: entry.slug,
          displayName: `Discovery ${tag} ${entry.name}`,
          description: `fixture ${word}`,
          visibility: entry.visibility,
          status: "active" as const,
          ownerUserId: "discovery-owner",
          verified: entry.verified,
          listedAt: entry.listedAt,
          repoOwner: owner,
          repoName: entry.repo,
          repoStars: entry.stars,
        })),
      );
      await data.db.insert(data.skillVersions).values(
        entries.map((entry) =>
          versionRow(entry, {
            id: entry.versionId,
            sha: SHA_NEW,
            isCurrent: true,
            createdAt: new Date("2026-05-02T00:00:00.000Z"),
          }),
        ),
      );
      const filed = entries.flatMap((entry) =>
        entry.categories.map((slug) => ({
          skillId: entry.id,
          categoryId: taxonomy.skillCategoryId(slug),
        })),
      );
      if (filed.length > 0)
        await data.db.insert(data.skillDefinitionCategories).values(filed);
    }

    async function getJson<T>(path: string, status = 200): Promise<T> {
      const response = await app.request(path);
      assert.equal(response.status, status, path);
      return (await response.json()) as T;
    }

    async function list(params: Record<string, string | number>) {
      const search = new URLSearchParams(
        Object.entries(params).map(([key, value]) => [key, String(value)]),
      );
      const body = await getJson<ListMarketSkillsResponse>(
        `/v1/skills?${search}`,
      );
      listMarketSkillsResponseSchema.strict().parse(body);
      return body;
    }

    async function walk(params: Record<string, string | number>) {
      const slugs: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await list({ ...params, ...(cursor ? { cursor } : {}) });
        slugs.push(...page.items.map((item) => item.slug));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
        assert.ok(pages < 1000, "paging did not terminate");
      } while (cursor);
      return slugs;
    }

    // The ranking fixtures: stars spread out, ties on purpose, some verified.
    const ranked: Fixture[] = [];
    const byName = (name: string) =>
      [...ranked, ...extra].find((entry) => entry.name === name)!;
    const extra: Fixture[] = [];

    beforeAll(async () => {
      if (
        !new URL(process.env.DATABASE_URL!).pathname.startsWith(
          "/sourceweft_skillv6_",
        )
      )
        throw new Error("Refusing non-isolated database");
      data = await import("@sourceweft/db");
      rank = await import("./rank");
      installCounts = await import("./install-counts");
      autoList = await import("./auto-list");
      collections = await import("./collections");
      repoMetadata = await import("./repo-metadata");
      taxonomy = await import("./taxonomy");
      service = new (await import("../service")).ContentSkillsService();
      await (await import("./listing")).ensureSkillCategories();

      app = new Hono();
      const routes = await import("../../../api/routes/skills-public");
      const { ApiError, ApiResponse, toApiError } =
        await import("../../../api/response/api-response");
      routes.registerSkillPublicRoutes(app);
      app.notFound((c) => ApiResponse.error(c, ApiError.notFound()));
      app.onError((error, c) => ApiResponse.error(c, toApiError(error)));

      const stars = [0, 5, 5, 40, 40, 900, 12_000, 0, 5, 120_000, 40];
      stars.forEach((count, index) =>
        ranked.push(
          fixture({
            name: `r${String(index).padStart(2, "0")}`,
            stars: count,
            verified: index % 4 === 1,
            // Two listing dates, so rank ties fall back to them, then the id.
            listedAt: new Date(
              index % 2 === 0
                ? "2026-05-01T00:00:00.000Z"
                : "2026-06-01T00:00:00.000Z",
            ),
            categories: index % 3 === 0 ? ["documents-office"] : [],
          }),
        ),
      );
      // Not public: never in a list, a related section or a collection.
      extra.push(
        fixture({
          name: "private",
          visibility: "restricted",
          stars: 999_999,
          categories: ["documents-office"],
        }),
        fixture({ name: "other1", repo: "other", categories: [] }),
      );
      await insert([...ranked, ...extra]);
      // The rank score is the scheduler's to write; here it is written for
      // these rows the same way.
      await installCounts.refreshSkillRankScores();
    });

    afterAll(async () => {
      if (!data) return;
      if (collectionIds.length > 0)
        await data.db
          .delete(data.skillCollections)
          .where(inArray(data.skillCollections.id, collectionIds));
      if (skillIds.length > 0)
        await data.db
          .delete(data.skillDefinitions)
          .where(inArray(data.skillDefinitions.id, skillIds));
      await data.db
        .delete(data.skillRepositories)
        .where(sql`${data.skillRepositories.repoOwner} like ${`%${tag}%`}`);
      await data.closeDatabase();
    });

    // --- sorts --------------------------------------------------------------

    const publicRanked = () =>
      ranked.filter((entry) => entry.visibility === "public");
    const byIdDesc = (a: Fixture, b: Fixture) =>
      a.id < b.id ? 1 : a.id > b.id ? -1 : 0;

    test("rank_score is the formula of rank.ts", async () => {
      const rows = await data.db
        .select({
          id: data.skillDefinitions.id,
          rankScore: data.skillDefinitions.rankScore,
          installCount: data.skillDefinitions.installCount,
          repoStars: data.skillDefinitions.repoStars,
        })
        .from(data.skillDefinitions)
        .where(inArray(data.skillDefinitions.id, skillIds));
      for (const row of rows)
        assert.equal(row.rankScore, rank.skillRankScore(row), row.id);
    });

    test("recommended pages by verified, rank score, listing date and id — no gaps, no repeats", async () => {
      // Installs are refreshed by other suites at any time; with none on these
      // rows, the score is the stars alone and the order is fixed.
      const expected = [...publicRanked(), ...extra]
        .filter((entry) => entry.visibility === "public")
        .sort(
          (a, b) =>
            Number(b.verified) - Number(a.verified) ||
            rank.skillRankScore({ repoStars: b.stars }) -
              rank.skillRankScore({ repoStars: a.stars }) ||
            b.listedAt.getTime() - a.listedAt.getTime() ||
            byIdDesc(a, b),
        )
        .map((entry) => entry.slug);
      for (const limit of [1, 2, 5, 100]) {
        const slugs = await walk({ query: word, sort: "recommended", limit });
        assert.deepEqual(slugs, expected, `limit ${limit}`);
      }
    });

    test("stars pages by the repository's stars, then id", async () => {
      const expected = [...publicRanked(), ...extra]
        .filter((entry) => entry.visibility === "public")
        .sort((a, b) => b.stars - a.stars || byIdDesc(a, b))
        .map((entry) => entry.slug);
      for (const limit of [1, 3, 100]) {
        assert.deepEqual(
          await walk({ query: word, sort: "stars", limit }),
          expected,
          `limit ${limit}`,
        );
      }
      // The same order in the workspace catalog, community skills only.
      const scope = {
        teamId: `team-${tag}`,
        workspaceId: `ws-${tag}`,
        userId: `viewer-${tag}`,
      };
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await service.listCatalog({
          ...scope,
          query: word,
          sort: "stars",
          limit: 4,
          cursor,
          filters: { trust: "all" },
        });
        seen.push(
          ...page.items
            .filter((item) => item.sourceType === "registry_github")
            .map((item) => item.slug),
        );
        cursor = page.nextCursor ?? undefined;
        // Counted with the cursor left out: the same on every page.
        assert.equal(page.registryTotal, expected.length);
      } while (cursor);
      assert.deepEqual(seen, expected);
    });

    test("the total is every match of the filters, whatever the page", async () => {
      const everything = await list({ query: word, limit: 2 });
      assert.equal(
        everything.totalCount,
        ranked.length + extra.length - 1, // the private one is not public
      );
      const verified = await list({ query: word, verified: "true", limit: 1 });
      assert.equal(
        verified.totalCount,
        ranked.filter((entry) => entry.verified).length,
      );
      const filed = await list({
        query: word,
        category: "documents-office",
        limit: 1,
      });
      assert.equal(
        filed.totalCount,
        ranked.filter((entry) => entry.categories.length > 0).length,
      );
      // A later page reports the same total as the first.
      const second = await list({
        query: word,
        category: "documents-office",
        limit: 1,
        cursor: filed.nextCursor!,
      });
      assert.equal(second.totalCount, filed.totalCount);
      const workspace = await service.listCatalog({
        teamId: `team-${tag}`,
        workspaceId: `ws-${tag}`,
        userId: `viewer-${tag}`,
        query: word,
        limit: 1,
        filters: { category: "documents-office" },
      });
      assert.equal(workspace.registryTotal, filed.totalCount);
    });

    // --- detail -------------------------------------------------------------

    test("related skills: same repository and same category, never itself or a private one", async () => {
      const self = byName("r00");
      const body = getMarketSkillResponseSchema.strict().parse(
        await getJson<GetMarketSkillResponse>(`/v1/skills/${self.slug}`),
      );
      const sameRepository = body.related!.sameRepository.map((s) => s.slug);
      const sameCategory = body.related!.sameCategory.map((s) => s.slug);
      assert.ok(sameRepository.length > 0 && sameRepository.length <= 6);
      assert.ok(!sameRepository.includes(self.slug));
      assert.ok(!sameCategory.includes(self.slug));
      assert.ok(!sameRepository.includes(byName("private").slug));
      assert.ok(!sameCategory.includes(byName("private").slug));
      // Another repository of the same owner is not the same repository.
      assert.ok(!sameRepository.includes(byName("other1").slug));
      for (const slug of sameRepository)
        assert.ok(ranked.some((entry) => entry.slug === slug), slug);
      // Filed alike, and not already shown as from the same repository.
      for (const slug of sameCategory) {
        assert.ok(!sameRepository.includes(slug), slug);
        const entry = [...ranked, ...extra].find((e) => e.slug === slug);
        if (entry) assert.ok(entry.categories.includes("documents-office"));
      }
      assert.equal(body.skill.cliInstallable, true);
    });

    // --- collections --------------------------------------------------------

    test("collections: only published ones, only their public skills, in order", async () => {
      const published = await collections.createSkillCollection({
        slug: `picks-${tag}`,
        title: `Picks ${tag}`,
        summary: "Hand-picked",
        published: true,
      });
      const draft = await collections.createSkillCollection({
        slug: `draft-${tag}`,
        title: `Draft ${tag}`,
      });
      collectionIds.push(published.id, draft.id);
      await collections.setSkillCollectionItems(published.id, [
        byName("r03").slug,
        byName("private").slug,
        byName("r01").slug,
      ]);
      await collections.setSkillCollectionItems(draft.id, [byName("r02").slug]);
      await assert.rejects(
        collections.setSkillCollectionItems(published.id, [`nope-${tag}`]),
        (error: { code?: string }) =>
          error.code === "SKILL_COLLECTION_UNKNOWN_SKILL",
      );
      await assert.rejects(
        collections.createSkillCollection({
          slug: `picks-${tag}`,
          title: "Again",
        }),
        (error: { code?: string }) =>
          error.code === "SKILL_COLLECTION_SLUG_TAKEN",
      );

      const listed = listMarketSkillCollectionsResponseSchema.parse(
        await getJson("/v1/skills/collections"),
      );
      const mine = listed.items.filter((item) => item.slug.includes(tag));
      assert.deepEqual(
        mine.map((item) => [item.slug, item.itemCount]),
        [[`picks-${tag}`, 2]],
      );

      const one = getMarketSkillCollectionResponseSchema.strict().parse(
        await getJson(`/v1/skills/collections/picks-${tag}`),
      );
      assert.deepEqual(
        one.items.map((item) => item.slug),
        [byName("r03").slug, byName("r01").slug],
      );
      await getJson(`/v1/skills/collections/draft-${tag}`, 404);

      // The admin sees every item, and which of them the public sees.
      const admin = await collections.getSkillCollectionForAdmin(published.id);
      assert.deepEqual(
        admin!.items.map((item) => [item.slug, item.public]),
        [
          [byName("r03").slug, true],
          [byName("private").slug, false],
          [byName("r01").slug, true],
        ],
      );

      // Unpublishing takes it off the public side at once.
      await collections.updateSkillCollection(published.id, {
        published: false,
      });
      await getJson(`/v1/skills/collections/picks-${tag}`, 404);
      assert.ok(await collections.deleteSkillCollection(draft.id));
      assert.equal(await collections.getSkillCollectionForAdmin(draft.id), null);
    });

    // --- listing queue, option A ---------------------------------------------

    test("a public skill whose new version adds flags or scripts waits for an admin, and stays public", async () => {
      const flagged = fixture({ name: "upd-flags", repo: "updates" });
      const scripted = fixture({ name: "upd-scripts", repo: "updates" });
      const quiet = fixture({ name: "upd-quiet", repo: "updates" });
      await insert([flagged, scripted, quiet]);
      const older = new Date("2026-04-01T00:00:00.000Z");
      // Each gets an older published version; the current one (inserted
      // above at SHA_NEW) is rewritten with what it adds.
      const updates: Array<
        [Fixture, { flags?: string[]; scripts?: string[] }]
      > = [
        [flagged, { flags: ["egress:fetch"] }],
        [scripted, { scripts: ["scripts/run.sh"] }],
        [quiet, {}],
      ];
      for (const [entry, current] of updates) {
        await data.db.insert(data.skillVersions).values(
          versionRow(entry, {
            id: randomUUID(),
            sha: SHA_OLD,
            isCurrent: false,
            createdAt: older,
          }),
        );
        await data.db
          .update(data.skillVersions)
          .set({ manifestJson: manifest(entry, SHA_NEW, current) })
          .where(eq(data.skillVersions.id, entry.versionId));
      }

      const queued = async () =>
        (await autoList.listSkillListingQueue()).filter((item) =>
          item.slug.includes(tag),
        );
      const entries = await queued();
      assert.deepEqual(
        entries.map((item) => [item.slug, item.reason, item.visibility]).sort(),
        [
          [flagged.slug, "new-version-flags", "public"],
          [scripted.slug, "new-version-scripts", "public"],
        ].sort(),
      );
      const flaggedEntry = entries.find((item) => item.slug === flagged.slug)!;
      assert.deepEqual(flaggedEntry.changes!.newFlags, ["egress:fetch"]);
      assert.equal(
        flaggedEntry.changes!.compareUrl,
        `https://github.com/${owner}/updates/compare/${SHA_OLD}...${SHA_NEW}`,
      );
      assert.deepEqual(
        entries.find((item) => item.slug === scripted.slug)!.changes!
          .newScripts,
        ["scripts/run.sh"],
      );

      // Still public meanwhile.
      const [definition] = await data.db
        .select({ visibility: data.skillDefinitions.visibility })
        .from(data.skillDefinitions)
        .where(eq(data.skillDefinitions.id, flagged.id));
      assert.equal(definition!.visibility, "public");

      // Kept: out of the queue, and recorded on the version.
      const kept = await autoList.acknowledgeSkillVersion({
        skillVersionId: flagged.versionId,
        actorUserId: `admin-${tag}`,
      });
      assert.equal(kept?.skillId, flagged.id);
      assert.deepEqual(
        (await queued()).map((item) => item.slug),
        [scripted.slug],
      );
      const [stored] = await data.db
        .select({ manifestJson: data.skillVersions.manifestJson })
        .from(data.skillVersions)
        .where(eq(data.skillVersions.id, flagged.versionId));
      const market = (
        stored!.manifestJson as unknown as {
          market?: { acknowledgedAt?: string; acknowledgedBy?: string };
        }
      ).market;
      assert.equal(market?.acknowledgedBy, `admin-${tag}`);
      assert.ok(market?.acknowledgedAt);
      // The registry's own record is untouched.
      assert.deepEqual(stored!.manifestJson.registry?.scan.flags, [
        "egress:fetch",
      ]);

      // Only a current version of a public skill can be kept.
      const [old] = await data.db
        .select({ id: data.skillVersions.id })
        .from(data.skillVersions)
        .where(
          and(
            eq(data.skillVersions.skillId, scripted.id),
            eq(data.skillVersions.isCurrent, false),
          ),
        );
      assert.equal(
        await autoList.acknowledgeSkillVersion({
          skillVersionId: old!.id,
          actorUserId: `admin-${tag}`,
        }),
        null,
      );
    });

    // --- repository metadata --------------------------------------------------

    test("the repository refresh stores GitHub's facts, keeps its ETag, and leaves a missing repository alone", async () => {
      const alive = fixture({ name: "meta-alive", repo: "alive", stars: 0 });
      const gone = fixture({ name: "meta-gone", repo: "gone", stars: 7 });
      await insert([alive, gone]);
      // Known already: its stars stay as they were when GitHub says 404.
      await data.db.insert(data.skillRepositories).values({
        repoOwner: owner,
        repoName: "gone",
        stars: 7,
        etag: '"gone-etag"',
      });

      const calls: Array<{ url: string; headers: Record<string, string> }> =
        [];
      const fetch = async (url: string, headers: Record<string, string>) => {
        calls.push({ url, headers });
        if (url.endsWith(`/${owner}/alive`)) {
          if (headers["If-None-Match"] === '"v1"')
            return new Response(null, { status: 304 });
          return new Response(
            JSON.stringify({
              id: 101,
              default_branch: "trunk",
              stargazers_count: 321,
              forks_count: 12,
              pushed_at: "2026-09-18T10:00:00Z",
              archived: true,
              owner: { id: 55, type: "Organization" },
            }),
            { status: 200, headers: { etag: '"v1"' } },
          );
        }
        if (url.endsWith(`/${owner}/gone`))
          return new Response("{}", { status: 404 });
        // Everyone else's repositories: nothing new.
        return new Response(null, { status: 304 });
      };
      const repo = async (name: string) =>
        (
          await data.db
            .select()
            .from(data.skillRepositories)
            .where(
              and(
                eq(data.skillRepositories.repoOwner, owner),
                eq(data.skillRepositories.repoName, name),
              ),
            )
        )[0];

      const first = await repoMetadata.refreshSkillRepositoryMetadata({
        batchSize: 10_000,
        deps: { fetch },
      });
      assert.ok(first.refreshed >= 1 && first.missing >= 1);
      const stored = await repo("alive");
      assert.equal(stored?.stars, 321);
      assert.equal(stored?.forks, 12);
      assert.equal(stored?.archived, true);
      assert.equal(stored?.defaultBranch, "trunk");
      assert.equal(stored?.githubId, "101");
      assert.equal(stored?.ownerGithubId, "55");
      assert.equal(stored?.ownerType, "Organization");
      assert.equal(stored?.etag, '"v1"');
      assert.equal(stored?.pushedAt?.toISOString(), "2026-09-18T10:00:00.000Z");
      const aliveFetchedAt = stored!.fetchedAt!;
      // The stored ETag goes out with the request.
      assert.equal(
        calls.find((call) => call.url.endsWith(`/${owner}/gone`))?.headers[
          "If-None-Match"
        ],
        '"gone-etag"',
      );
      // Stars onto the skill; a 404 changes nothing but the time it was read.
      const stars = async (id: string) =>
        (
          await data.db
            .select({ repoStars: data.skillDefinitions.repoStars })
            .from(data.skillDefinitions)
            .where(eq(data.skillDefinitions.id, id))
        )[0]!.repoStars;
      assert.equal(await stars(alive.id), 321);
      assert.equal(await stars(gone.id), 7);
      const goneRow = await repo("gone");
      assert.equal(goneRow?.stars, 7);
      assert.equal(goneRow?.etag, '"gone-etag"');
      assert.ok(goneRow?.fetchedAt);

      // Second pass: 304, so only the time moves.
      calls.length = 0;
      await repoMetadata.refreshSkillRepositoryMetadata({
        batchSize: 10_000,
        deps: { fetch },
      });
      assert.equal(
        calls.find((call) => call.url.endsWith(`/${owner}/alive`))?.headers[
          "If-None-Match"
        ],
        '"v1"',
      );
      const after = await repo("alive");
      assert.equal(after?.stars, 321);
      assert.equal(after?.etag, '"v1"');
      assert.ok(after!.fetchedAt!.getTime() >= aliveFetchedAt.getTime());
      // The skills are still listed, the missing repository's included.
      const listed = await list({ query: `${word} meta`, limit: 10 });
      assert.deepEqual(
        listed.items.map((item) => item.slug).sort(),
        [alive.slug, gone.slug].sort(),
      );
      const aliveSummary = listed.items.find((i) => i.slug === alive.slug)!;
      assert.equal(aliveSummary.stars, 321);
      assert.equal(aliveSummary.repoArchived, true);
      assert.equal(aliveSummary.repoPushedAt, "2026-09-18T10:00:00.000Z");
    });
  },
);
