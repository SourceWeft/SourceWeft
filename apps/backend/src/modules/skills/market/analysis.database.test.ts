import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";

describe.skipIf(process.env.RUN_SKILL_DB_TESTS !== "1")(
  "AI analysis atomic publication",
  () => {
    let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
    let data: typeof import("@sourceweft/db");
    let repo: typeof import("./analysis-repository");
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase("skillanalysis");
      process.env.DATABASE_URL = isolated.url;
      data = await import("@sourceweft/db");
      repo = await import("./analysis-repository");
    }, 180_000);
    afterAll(async () => {
      if (data) await data.closeDatabase();
      if (isolated) await isolated.close();
    });

    const classification = {
      status: "ready" as const,
      primary: "data-analytics",
      secondary: null,
      rationale: "Creates charts",
      evidence: ["Makes charts."],
    };
    const localized = (summary: string) => ({
      summary,
      whatItDoes: summary,
      whenToUse: "Charts",
      requirements: "",
      suggestedCategories: ["data-analytics"],
    });
    const overviews = {
      en: localized("Makes charts."),
      "zh-CN": localized("生成图表。"),
      "zh-TW": localized("製作圖表，整理資料。"),
    };
    async function fixture(manual = false) {
      const skillId = randomUUID(),
        skillVersionId = randomUUID();
      await data.db
        .insert(data.skillDefinitions)
        .values({
          id: skillId,
          sourceType: "registry_github",
          slug: skillId,
          displayName: "Charts",
          description: "Makes charts.",
          visibility: "public",
          status: "active",
          categoriesSetBy: manual ? "admin" : null,
        });
      await data.db
        .insert(data.skillVersions)
        .values({
          id: skillVersionId,
          skillId,
          version: "1",
          status: "published",
          storageType: "db_text",
          storagePointer: "test",
          isCurrent: true,
          contentHash: skillVersionId,
          skillMd: "Makes charts.",
          manifestJson: {
            slug: skillId,
            displayName: "Charts",
            version: "1",
            description: "Makes charts.",
            visibility: "public",
            categories: [],
          },
        });
      const state = await repo.requestSkillAnalysis(skillVersionId, false);
      await repo.claimSkillAnalysis(skillVersionId, state!.requestId);
      return {
        skillId,
        skillVersionId,
        requestId: state!.requestId,
        resultKey: randomUUID(),
        bundleSha256: "sha",
        model: "test-model",
        classification,
        overviews,
      };
    }
    const rows = (id: string) =>
      data.db
        .select()
        .from(data.skillVersionOverviews)
        .where(eq(data.skillVersionOverviews.skillVersionId, id));
    test("all three independent locales and categories publish together", async () => {
      const f = await fixture();
      expect(await repo.publishSkillAnalysis(f)).toBe(true);
      expect(await rows(f.skillVersionId)).toHaveLength(3);
      expect(
        (await rows(f.skillVersionId)).find((x) => x.locale === "zh-TW")!
          .overview.summary,
      ).toBe("製作圖表，整理資料。");
      const [d] = await data.db
        .select()
        .from(data.skillDefinitions)
        .where(eq(data.skillDefinitions.id, f.skillId));
      expect(d!.categoriesSetBy).toBe("ai");
      expect(
        await data.db
          .select()
          .from(data.skillDefinitionCategories)
          .where(eq(data.skillDefinitionCategories.skillId, f.skillId)),
      ).toHaveLength(1);
      expect(
        await repo.requestSkillAnalysis(f.skillVersionId, false),
      ).toBeNull();
      expect(await repo.publishSkillAnalysis(f)).toBe(false);
    });
    test("manual categories are never overwritten, but overview is generated", async () => {
      const f = await fixture(true);
      expect(await repo.publishSkillAnalysis(f)).toBe(true);
      const [d] = await data.db
        .select()
        .from(data.skillDefinitions)
        .where(eq(data.skillDefinitions.id, f.skillId));
      expect(d!.categoriesSetBy).toBe("admin");
      expect(await rows(f.skillVersionId)).toHaveLength(3);
      expect(
        await data.db
          .select()
          .from(data.skillDefinitionCategories)
          .where(eq(data.skillDefinitionCategories.skillId, f.skillId)),
      ).toHaveLength(0);
    });
    test("new regeneration fences older request; failed update retains old output", async () => {
      const f = await fixture();
      await repo.publishSkillAnalysis(f);
      const next = await repo.requestSkillAnalysis(f.skillVersionId, true);
      await repo.claimSkillAnalysis(f.skillVersionId, next!.requestId);
      expect(await repo.publishSkillAnalysis(f)).toBe(false);
      await repo.failSkillAnalysis(
        f.skillVersionId,
        next!.requestId,
        "test failure",
        false,
      );
      expect(await rows(f.skillVersionId)).toHaveLength(3);
      expect((await repo.readSkillAnalysis(f.skillVersionId))!.status).toBe(
        "failed",
      );
      // Late failure from the old request cannot corrupt the new failure state.
      await repo.failSkillAnalysis(f.skillVersionId, f.requestId, "old", false);
      expect((await repo.readSkillAnalysis(f.skillVersionId))!.error).toBe(
        "test failure",
      );
    });
    test("a version that is no longer current cannot publish or change categories", async () => {
      const f = await fixture();
      await data.db
        .update(data.skillVersions)
        .set({ isCurrent: false })
        .where(eq(data.skillVersions.id, f.skillVersionId));
      expect(await repo.publishSkillAnalysis(f)).toBe(false);
      expect(await rows(f.skillVersionId)).toHaveLength(0);
      expect((await repo.readSkillAnalysis(f.skillVersionId))!.status).toBe(
        "failed",
      );
    });
    test("cache requires matching revision key, all locales and visible output", async () => {
      const f = await fixture();
      await repo.publishSkillAnalysis(f);
      expect(
        await repo.findCachedSkillAnalysis(f.resultKey, "another-version"),
      ).not.toBeNull();
      expect(
        await repo.findCachedSkillAnalysis(
          "different-model-or-prompt",
          "another-version",
        ),
      ).toBeNull();
      await data.db
        .update(data.skillVersionOverviews)
        .set({ hidden: true })
        .where(eq(data.skillVersionOverviews.skillVersionId, f.skillVersionId));
      expect(
        await repo.findCachedSkillAnalysis(f.resultKey, "another-version"),
      ).toBeNull();
      await data.db
        .update(data.skillVersionOverviews)
        .set({ hidden: false })
        .where(eq(data.skillVersionOverviews.skillVersionId, f.skillVersionId));
      await data.db
        .delete(data.skillVersionOverviews)
        .where(eq(data.skillVersionOverviews.locale, "zh-TW"));
      expect(
        await repo.findCachedSkillAnalysis(f.resultKey, "another-version"),
      ).toBeNull();
    });
    test("needs-review publishes overview without inventing categories", async () => {
      const f = await fixture();
      expect(
        await repo.publishSkillAnalysis({
          ...f,
          classification: {
            status: "needs-review",
            primary: null,
            secondary: null,
            rationale: "Insufficient source",
            evidence: [],
          },
        }),
      ).toBe(true);
      expect((await repo.readSkillAnalysis(f.skillVersionId))!.status).toBe(
        "needs-review",
      );
      expect(
        await data.db
          .select()
          .from(data.skillDefinitionCategories)
          .where(eq(data.skillDefinitionCategories.skillId, f.skillId)),
      ).toHaveLength(0);
    });
    test("hidden overview stays hidden on successful regeneration", async () => {
      const f = await fixture();
      await repo.publishSkillAnalysis(f);
      await data.db
        .update(data.skillVersionOverviews)
        .set({ hidden: true })
        .where(eq(data.skillVersionOverviews.skillVersionId, f.skillVersionId));
      const next = await repo.requestSkillAnalysis(f.skillVersionId, true);
      await repo.claimSkillAnalysis(f.skillVersionId, next!.requestId);
      expect(
        await repo.publishSkillAnalysis({ ...f, requestId: next!.requestId }),
      ).toBe(true);
      expect((await rows(f.skillVersionId)).every((row) => row.hidden)).toBe(
        true,
      );
    });
    test("both bulk entry points reject migration without reviewed quality approval", async () => {
      const listing = await import("./listing");
      const admin = await import("./analysis-admin");
      await expect(
        listing.reinferAllSkillCategories({ actorUserId: "admin" }),
      ).rejects.toMatchObject({ code: "SKILL_ANALYSIS_QUALITY_REQUIRED" });
      await expect(
        admin.enqueueSkillAnalysisBatch(["version"], "admin"),
      ).rejects.toMatchObject({ code: "SKILL_ANALYSIS_QUALITY_REQUIRED" });
    });
    test("AI primary category is first even when taxonomy display order differs", async () => {
      const f = await fixture();
      await repo.publishSkillAnalysis({
        ...f,
        classification: {
          ...classification,
          primary: "security",
          secondary: "development",
        },
      });
      const listing = await import("./listing");
      expect(
        (await listing.listSkillCategorySlugs([f.skillId])).get(f.skillId),
      ).toEqual(["security", "development"]);
    });
  },
);
