import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, test } from "vitest";
import { inArray } from "drizzle-orm";
import {
  loadSkillDatabase,
  seedSkillDefinition,
  skillDatabaseEnabled,
} from "../../../test/skill-database";

/**
 * AI overviews against real PostgreSQL: which versions are picked, the copy
 * from identical content, generation with the model mocked, the language
 * fallback on the public reads, and the billing target check.
 *
 * Scoped to this file's own rows (every query that could reach others takes
 * `skillIds`); the market-wide `overview.billing` setting is never written,
 * since a live stack shares this database and would start generating.
 */
describe.skipIf(!skillDatabaseEnabled)(
  "skill AI overviews (real PostgreSQL)",
  () => {
    let data: typeof import("@sourceweft/db");
    let repo: typeof import("./overview-repository");
    let generate: typeof import("./overview-generate");
    let read: typeof import("./read-repository");

    const tag = randomUUID().slice(0, 8);
    const ownerUserId = `overview-owner-${tag}`;
    const sharedSha = randomUUID().replace(/-/g, "").padEnd(64, "a");
    const skillIds: string[] = [];
    const workspaceId = `overview-ws-${randomUUID()}`;
    const teamId = `overview-team-${randomUUID()}`;
    const memberId = `overview-member-${tag}`;

    type Fixture = {
      id: string;
      versionId: string;
      slug: string;
      bundleSha256: string;
    };

    async function insertSkill(input: {
      name: string;
      visibility?: "public" | "restricted";
      bundleSha256?: string;
      skillMd?: string;
    }): Promise<Fixture> {
      const fixture = {
        id: randomUUID(),
        versionId: randomUUID(),
        slug: `gh-ovw-${tag}-${input.name}`,
        bundleSha256:
          input.bundleSha256 ?? randomUUID().replace(/-/g, "").padEnd(64, "b"),
      };
      skillIds.push(fixture.id);
      const visibility = input.visibility ?? "public";
      await seedSkillDefinition(data, {
        id: fixture.id,
        slug: fixture.slug,
        displayName: `Overview ${tag} ${input.name}`,
        visibility,
        ownerUserId,
      });
      await data.db.insert(data.skillVersions).values({
        id: fixture.versionId,
        skillId: fixture.id,
        version: "aaaaaaaaaaaa",
        status: "published",
        storageType: "object",
        skillMd:
          input.skillMd ??
          `---\nname: ${input.name}\ndescription: fixture\n---\nMakes charts.\n`,
        bundleSha256: fixture.bundleSha256,
        bundleObjectKey: `skills/bundles/${fixture.bundleSha256}.zip`,
        bundleSizeBytes: 1,
        storagePointer: `github:fixture/skills@${"a".repeat(40)}#${input.name}`,
        isCurrent: true,
        contentHash: "hash",
        manifestJson: {
          slug: fixture.slug,
          displayName: `Overview ${tag} ${input.name}`,
          version: "aaaaaaaaaaaa",
          description: "fixture",
          visibility,
          categories: [],
          registry: {
            identifier: `gh:fixture/skills/${input.name}`,
            sourceUrl: `https://github.com/fixture/skills/tree/${"a".repeat(40)}/${input.name}`,
            repoUrl: "https://github.com/fixture/skills",
            submittedBy: ownerUserId,
            provenance: {
              defaultBranch: "main",
              checkedAt: "2026-01-01T00:00:00.000Z",
            },
            capability: "executable",
            scan: { reviewRequired: false, flags: [] },
            fileManifest: [
              {
                path: "SKILL.md",
                sha256: "c".repeat(64),
                sizeBytes: 10,
                role: "model-readable",
              },
              {
                path: "scripts/plot.py",
                sha256: "d".repeat(64),
                sizeBytes: 10,
                role: "script",
              },
            ],
          },
        },
      });
      return fixture;
    }

    function overview(summary: string) {
      return {
        summary,
        whatItDoes: `${summary} — does it.`,
        whenToUse: "When needed.",
        requirements: "",
        suggestedCategories: [],
      };
    }

    let source: Fixture;
    let twin: Fixture;
    let restricted: Fixture;
    let fresh: Fixture;

    beforeAll(async () => {
      data = await loadSkillDatabase();
      repo = await import("./overview-repository");
      generate = await import("./overview-generate");
      read = await import("./read-repository");

      // `source` has overviews; `twin` is the same content without any.
      source = await insertSkill({ name: "source", bundleSha256: sharedSha });
      twin = await insertSkill({ name: "twin", bundleSha256: sharedSha });
      restricted = await insertSkill({
        name: "restricted",
        visibility: "restricted",
      });
      fresh = await insertSkill({ name: "fresh" });
      await repo.storeSkillOverviews({
        skillVersionId: source.versionId,
        bundleSha256: sharedSha,
        model: "fixture-model",
        overviews: {
          en: overview("English summary"),
          "zh-CN": overview("简体摘要"),
          "zh-TW": overview("繁體摘要"),
        },
      });

      await data.db.insert(data.workspaces).values({
        id: workspaceId,
        organizationId: teamId,
        name: `Overview ${tag}`,
        slug: `overview-${tag}`,
      });
      await data.db.insert(data.workspaceMemberships).values([
        { workspaceId, userId: memberId, source: "direct" },
        { workspaceId, userId: `${memberId}-guest`, source: "guest" },
      ]);
      // Importing the read path loads the model gateway and the market.
    }, 180_000);

    afterAll(async () => {
      if (!data) return;
      // Versions and overviews go with their definition (CASCADE).
      if (skillIds.length > 0) {
        await data.db
          .delete(data.skillDefinitions)
          .where(inArray(data.skillDefinitions.id, skillIds));
      }
      await data.db
        .delete(data.workspaces)
        .where(inArray(data.workspaces.id, [workspaceId]));
    });

    test("candidates are public GitHub skills' current versions without an overview", async () => {
      const found = await repo.findSkillOverviewCandidates({
        limit: 50,
        skillIds,
      });
      assert.deepEqual(
        found.map((candidate) => candidate.skillVersionId).sort(),
        [twin.versionId, fresh.versionId].sort(),
      );
      const forTwin = found.find((c) => c.skillVersionId === twin.versionId);
      assert.equal(forTwin?.bundleSha256, sharedSha);
    });

    test("generation stores three independently authored locales; the model is mocked", async () => {
      const calls: Array<{ userPrompt: string; userId: string }> = [];
      const result = await generate.generateSkillOverview({
        skillVersionId: fresh.versionId,
        scopeId: `test-${tag}`,
        readBilling: async () => ({ teamId, workspaceId, userId: memberId }),
        callModel: async ({ prompt, billing }) => {
          calls.push({ userPrompt: prompt.user, userId: billing.userId });
          return {
            model: "mock-model",
            output: {
              en: {
                summary: "Draws charts from spreadsheets.",
                whatItDoes: "Reads a sheet and draws charts.",
                whenToUse: "When a chart is needed.",
                requirements: "Python 3; ships a script.",
              },
              "zh-CN": {
                summary: "从表格生成图表。",
                whatItDoes: "读取表格并绘制图表。",
                whenToUse: "需要图表时。",
                requirements: "需要 Python 3。",
              },
              "zh-TW": {
                summary: "製作圖表，整理資料。",
                whatItDoes: "讀取試算表並繪製圖表。",
                whenToUse: "需要圖表時。",
                requirements: "需要 Python 3。",
              },
              classification: {
                status: "ready",
                primary: "data-analytics",
                secondary: null,
                rationale: "Creates charts",
                evidence: ["Makes charts."],
              },
            },
          };
        },
      });
      assert.deepEqual(result, { status: "generated", model: "mock-model" });
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.userId, memberId);
      assert.match(calls[0]!.userPrompt, /scripts\/plot\.py \(script\)/);
      assert.match(calls[0]!.userPrompt, /Makes charts\./);

      const state = await repo.findSkillOverviewAdminState(fresh.id);
      const byLocale = new Map(
        state!.overviews.map((row) => [row.locale, row]),
      );
      assert.equal(byLocale.get("en")?.model, "mock-model");
      assert.equal(
        byLocale.get("zh-TW")?.overview.summary,
        "製作圖表，整理資料。",
      );
      assert.deepEqual(byLocale.get("zh-TW")?.overview.suggestedCategories, [
        "data-analytics",
      ]);

      // Done once; a second run does not call the model.
      const again = await generate.generateSkillOverview({
        skillVersionId: fresh.versionId,
        scopeId: `test-${tag}-2`,
        readBilling: async () => ({ teamId, workspaceId, userId: memberId }),
        callModel: async () => {
          throw new Error("must not be called");
        },
      });
      assert.deepEqual(again, {
        status: "skipped",
        reason: "already-generated",
      });

      const notPublic = await generate.generateSkillOverview({
        skillVersionId: restricted.versionId,
        scopeId: `test-${tag}-3`,
        readBilling: async () => ({ teamId, workspaceId, userId: memberId }),
        callModel: async () => {
          throw new Error("must not be called");
        },
      });
      assert.deepEqual(notPublic, {
        status: "skipped",
        reason: "not-eligible",
      });
    });

    test("reads fall back to English, and skip hidden rows", async () => {
      // Only English for `fresh`.
      await data.db
        .delete(data.skillVersionOverviews)
        .where(
          inArray(data.skillVersionOverviews.skillVersionId, [fresh.versionId]),
        );
      await data.db.insert(data.skillVersionOverviews).values({
        skillVersionId: fresh.versionId,
        locale: "en",
        bundleSha256: fresh.bundleSha256,
        overview: overview("Only English"),
        model: "m",
      });

      const reads = await repo.readSkillOverviews({
        skillVersionIds: [
          fresh.versionId,
          source.versionId,
          restricted.versionId,
        ],
        locale: "zh-TW",
      });
      assert.equal(reads.get(fresh.versionId)?.locale, "en");
      assert.equal(
        reads.get(fresh.versionId)?.overview.summary,
        "Only English",
      );
      assert.equal(reads.get(source.versionId)?.locale, "zh-TW");
      assert.equal(reads.get(source.versionId)?.overview.summary, "繁體摘要");
      assert.equal(reads.has(restricted.versionId), false);

      const languages = await repo.readSkillOverviewLocales([
        source.versionId,
        fresh.versionId,
        restricted.versionId,
      ]);
      assert.deepEqual(languages.get(source.versionId), [
        "en",
        "zh-CN",
        "zh-TW",
      ]);
      assert.deepEqual(languages.get(fresh.versionId), ["en"]);
      assert.equal(languages.has(restricted.versionId), false);
      assert.equal((await repo.readSkillOverviewLocales([])).size, 0);

      // Hidden: gone from the public reads, still in the admin view.
      assert.equal(
        await repo.setSkillOverviewsHidden({
          skillVersionId: source.versionId,
          hidden: true,
        }),
        3,
      );
      const hidden = await repo.readSkillOverviews({
        skillVersionIds: [source.versionId],
        locale: "en",
      });
      assert.equal(hidden.has(source.versionId), false);
      assert.equal(
        (await repo.readSkillOverviewLocales([source.versionId])).has(
          source.versionId,
        ),
        false,
      );
      const hiddenList = await read.listMarketSkills({
        query: tag,
        locale: "zh-TW",
        limit: 50,
      });
      assert.deepEqual(
        hiddenList.items.find((item) => item.slug === source.slug)
          ?.overviewLocales,
        [],
      );
      const admin = await repo.findSkillOverviewAdminState(source.id);
      assert.equal(
        admin?.overviews.every((row) => row.hidden),
        true,
      );
      await repo.setSkillOverviewsHidden({
        skillVersionId: source.versionId,
        hidden: false,
      });
    });

    test("the public detail and list carry the overview in the asked language", async () => {
      const detail = await read.findMarketSkill(source.slug, {
        locale: "zh-CN",
      });
      assert.equal(detail?.aiOverview?.locale, "zh-CN");
      assert.equal(detail?.aiOverview?.summary, "简体摘要");
      assert.equal(detail?.skill.aiSummary, "简体摘要");

      const english = await read.findMarketSkill(fresh.slug, {
        locale: "zh-TW",
      });
      assert.equal(english?.aiOverview?.locale, "en");

      const none = await read.findMarketSkill(restricted.slug);
      assert.equal(none, null);

      const list = await read.listMarketSkills({
        query: tag,
        locale: "zh-TW",
        limit: 50,
      });
      const bySlug = new Map(list.items.map((item) => [item.slug, item]));
      assert.equal(bySlug.get(source.slug)?.aiSummary, "繁體摘要");
      assert.equal(bySlug.get(fresh.slug)?.aiSummary, "Only English");
      assert.deepEqual(bySlug.get(source.slug)?.overviewLocales, [
        "en",
        "zh-CN",
        "zh-TW",
      ]);
      assert.deepEqual(bySlug.get(fresh.slug)?.overviewLocales, ["en"]);
      // A list item carries only the summary.
      assert.equal("aiOverview" in (bySlug.get(source.slug) as object), false);
    });

    test("a collection's items carry the AI summary in the asked language", async () => {
      const collections = await import("./collections");
      const collectionId = randomUUID();
      const slug = `ovw-${tag}`;
      await data.db.insert(data.skillCollections).values({
        id: collectionId,
        slug,
        title: `Overview ${tag}`,
        published: true,
      });
      try {
        await data.db.insert(data.skillCollectionItems).values([
          { collectionId, skillId: source.id, position: 0 },
          { collectionId, skillId: fresh.id, position: 1 },
          { collectionId, skillId: restricted.id, position: 2 },
        ]);
        const zh = await collections.findPublicSkillCollection(slug, {
          locale: "zh-TW",
        });
        assert.deepEqual(
          zh?.items.map((item) => [item.slug, item.aiSummary]),
          [
            [source.slug, "繁體摘要"],
            // No zh-TW row: English.
            [fresh.slug, "Only English"],
          ],
        );
        // No locale: English.
        const en = await collections.findPublicSkillCollection(slug);
        assert.equal(en?.items[0]?.aiSummary, "English summary");
      } finally {
        await data.db
          .delete(data.skillCollections)
          .where(inArray(data.skillCollections.id, [collectionId]));
      }
    });

    test("deleting output does not silently restart a completed analysis", async () => {
      assert.equal(await repo.deleteSkillOverviews(fresh.versionId), 1);
      const left = await repo.findSkillOverviewCandidates({
        limit: 50,
        skillIds,
      });
      assert.deepEqual(
        left.map((c) => c.skillVersionId),
        [twin.versionId],
      );
    });

    test("a billing target must hold together", async () => {
      assert.equal(
        await repo.checkSkillOverviewBillingTarget({
          teamId,
          workspaceId,
          userId: memberId,
        }),
        null,
      );
      assert.equal(
        await repo.checkSkillOverviewBillingTarget({
          teamId: `${teamId}-other`,
          workspaceId,
          userId: memberId,
        }),
        "workspace_not_in_team",
      );
      assert.equal(
        await repo.checkSkillOverviewBillingTarget({
          teamId,
          workspaceId: `${workspaceId}-missing`,
          userId: memberId,
        }),
        "workspace_not_found",
      );
      assert.equal(
        await repo.checkSkillOverviewBillingTarget({
          teamId,
          workspaceId,
          userId: `${memberId}-guest`,
        }),
        "user_not_member",
      );
      assert.equal(
        await repo.checkSkillOverviewBillingTarget({
          teamId,
          workspaceId,
          userId: "nobody",
        }),
        "user_not_member",
      );
    });
  },
);
