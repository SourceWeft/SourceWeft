import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { eq, sql } from "drizzle-orm";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

/**
 * The engine's repository against real PostgreSQL. It is exercised on the
 * skill tables — the kind tables built from the shared column definitions —
 * with its own hooks, so what is proven here is the engine's SQL: atomic
 * publication, fencing, and the reads.
 */
describe("catalog overview repository (real PostgreSQL)", () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let data: typeof import("@sourceweft/db");
  let engine: typeof import("./repository");

  type Classification = {
    status: "ready" | "needs-review";
    primary: string | null;
    secondary: string | null;
    rationale: string;
    evidence: string[];
  };
  const ready: Classification = {
    status: "ready",
    primary: "development",
    secondary: null,
    rationale: "Builds software",
    evidence: ["Builds software."],
  };
  const localized = (summary: string, cautions?: string) => ({
    summary,
    whatItDoes: summary,
    whenToUse: "When needed.",
    requirements: "",
    ...(cautions === undefined ? {} : { cautions }),
    suggestedCategories: ["development"],
  });
  const overviews = (prefix: string) => ({
    en: localized(`${prefix} en`),
    "zh-CN": localized(`${prefix} zh-CN`),
    "zh-TW": localized(`${prefix} zh-TW`),
  });

  let eligible = true;
  let categoriesFail = false;
  let categoryCalls: Array<{ versionId: string; parentId: string }> = [];

  function repository(promptVersion = "p1") {
    return engine.createCatalogOverviewRepository<
      typeof data.skillVersionAnalysis,
      Classification
    >({
      overviews: {
        table: data.skillVersionOverviews,
        versionId: data.skillVersionOverviews.skillVersionId,
        fingerprint: data.skillVersionOverviews.bundleSha256,
      },
      analysis: {
        table: data.skillVersionAnalysis,
        versionId: data.skillVersionAnalysis.skillVersionId,
      },
      versions: {
        table: data.skillVersions,
        id: data.skillVersions.id,
        parentId: data.skillVersions.skillId,
      },
      promptVersion,
      taxonomyVersion: "t1",
      lockTarget: async () => eligible,
      applyCategories: async (tx, target) => {
        categoryCalls.push({
          versionId: target.versionId,
          parentId: target.parentId,
        });
        // A write inside the transaction, to prove it is rolled back too.
        await tx
          .update(data.skillDefinitions)
          .set({ categoriesSetBy: "ai" })
          .where(eq(data.skillDefinitions.id, target.parentId));
        if (categoriesFail) throw new Error("category write failed");
      },
    });
  }

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase("catalogoverview");
    process.env.DATABASE_URL = isolated.url;
    data = await import("@sourceweft/db");
    engine = await import("./repository");
  }, 180_000);
  afterAll(async () => {
    if (data) await data.closeDatabase();
    if (isolated) await isolated.close();
  });
  beforeEach(() => {
    eligible = true;
    categoriesFail = false;
    categoryCalls = [];
  });

  /** A version with a claimed (running) request, ready to publish. */
  async function claimed(repo = repository()) {
    const parentId = randomUUID();
    const versionId = randomUUID();
    await data.db.insert(data.skillDefinitions).values({
      id: parentId,
      sourceType: "registry_github",
      slug: parentId,
      displayName: "Fixture",
      description: "Builds software.",
      visibility: "public",
      status: "active",
    });
    await data.db.insert(data.skillVersions).values({
      id: versionId,
      skillId: parentId,
      version: "1",
      status: "published",
      storageType: "db_text",
      storagePointer: "test",
      isCurrent: true,
      contentHash: versionId,
      skillMd: "Builds software.",
      manifestJson: {
        slug: parentId,
        displayName: "Fixture",
        version: "1",
        description: "Builds software.",
        visibility: "public",
        categories: [],
      },
    });
    const state = await repo.request(versionId, false);
    await repo.claim(versionId, state!.requestId);
    return {
      parentId,
      versionId,
      requestId: state!.requestId,
      resultKey: randomUUID(),
      fingerprint: "fingerprint-1",
      model: "test-model",
      modelConfigurationKey: "model-config",
      classification: ready,
      overviews: overviews("first"),
    };
  }

  const rows = (versionId: string) =>
    data.db
      .select()
      .from(data.skillVersionOverviews)
      .where(eq(data.skillVersionOverviews.skillVersionId, versionId));
  const setBy = async (parentId: string) =>
    (
      await data.db
        .select({ setBy: data.skillDefinitions.categoriesSetBy })
        .from(data.skillDefinitions)
        .where(eq(data.skillDefinitions.id, parentId))
    )[0]?.setBy ?? null;

  test("every locale, the state and the categories commit together", async () => {
    const repo = repository();
    const f = await claimed(repo);
    expect(await repo.publish(f)).toBe(true);
    const written = await rows(f.versionId);
    expect(written.map((row) => row.locale).sort()).toEqual([
      "en",
      "zh-CN",
      "zh-TW",
    ]);
    expect(written.every((row) => row.bundleSha256 === "fingerprint-1")).toBe(
      true,
    );
    expect(await repo.read(f.versionId)).toMatchObject({
      status: "ready",
      resultKey: f.resultKey,
      modelConfigurationKey: "model-config",
      promptVersion: "p1",
      taxonomyVersion: "t1",
      force: false,
      error: null,
    });
    expect(categoryCalls).toEqual([
      { versionId: f.versionId, parentId: f.parentId },
    ]);
    expect(await setBy(f.parentId)).toBe("ai");
  });

  test("a failure in the kind's category write rolls every locale back", async () => {
    const repo = repository();
    const f = await claimed(repo);
    categoriesFail = true;
    await expect(repo.publish(f)).rejects.toThrow("category write failed");
    expect(await rows(f.versionId)).toHaveLength(0);
    expect(await setBy(f.parentId)).toBeNull();
    // The request is still the live one: the job can record the failure.
    expect((await repo.read(f.versionId))!.status).toBe("running");
  });

  test("a publication missing a locale is refused and writes nothing", async () => {
    const repo = repository();
    const f = await claimed(repo);
    const { "zh-TW": _missing, ...partial } = f.overviews;
    await expect(
      repo.publish({ ...f, overviews: partial as typeof f.overviews }),
    ).rejects.toThrow("Incomplete overview locales");
    expect(await rows(f.versionId)).toHaveLength(0);
    expect(categoryCalls).toHaveLength(0);
  });

  test("a newer request fences the older worker; its late failure changes nothing", async () => {
    const repo = repository();
    const f = await claimed(repo);
    const newer = await repo.request(f.versionId, true);
    expect(newer!.requestId).not.toBe(f.requestId);
    expect(await repo.publish(f)).toBe(false);
    expect(await rows(f.versionId)).toHaveLength(0);
    expect(categoryCalls).toHaveLength(0);
    await repo.fail(f.versionId, f.requestId, "late", false);
    expect(await repo.read(f.versionId)).toMatchObject({
      requestId: newer!.requestId,
      status: "pending",
      error: null,
    });
    // A request is reserved again only when forced.
    expect(await repo.request(f.versionId, false)).toBeNull();
  });

  test("an ineligible version is failed under lock and nothing is written", async () => {
    const repo = repository();
    const f = await claimed(repo);
    eligible = false;
    expect(await repo.publish(f)).toBe(false);
    expect(await rows(f.versionId)).toHaveLength(0);
    expect(await repo.read(f.versionId)).toMatchObject({
      status: "failed",
      error: "Version is no longer eligible",
    });
  });

  test("regeneration replaces text and fingerprint but keeps an admin's hide", async () => {
    const repo = repository();
    const f = await claimed(repo);
    await repo.publish(f);
    expect(
      await repo.setOverviewsHidden({ versionId: f.versionId, hidden: true }),
    ).toBe(3);
    const next = await repo.request(f.versionId, true);
    await repo.claim(f.versionId, next!.requestId);
    expect(
      await repo.publish({
        ...f,
        requestId: next!.requestId,
        fingerprint: "fingerprint-2",
        overviews: overviews("second"),
      }),
    ).toBe(true);
    const written = await rows(f.versionId);
    expect(written.every((row) => row.hidden)).toBe(true);
    expect(written.every((row) => row.bundleSha256 === "fingerprint-2")).toBe(
      true,
    );
    expect(written.find((row) => row.locale === "en")!.overview.summary).toBe(
      "second en",
    );
  });

  test("a result is reused only from complete, visible output of the same prompt and taxonomy", async () => {
    const repo = repository();
    const f = await claimed(repo);
    await repo.publish(f);
    expect(await repo.findCached(f.resultKey, "another-version")).toMatchObject(
      {
        classification: ready,
        model: "test-model",
        overviews: { en: { summary: "first en" } },
      },
    );
    // Never from the version asking.
    expect(await repo.findCached(f.resultKey, f.versionId)).toBeNull();
    // Another prompt version does not reuse it.
    expect(
      await repository("p2").findCached(f.resultKey, "another-version"),
    ).toBeNull();
    await repo.setOverviewsHidden({ versionId: f.versionId, hidden: true });
    expect(await repo.findCached(f.resultKey, "another-version")).toBeNull();
  });

  test("reads fall back to English, and rows without cautions read it as null", async () => {
    const repo = repository();
    const f = await claimed(repo);
    await repo.storeOverviews({
      versionId: f.versionId,
      fingerprint: "stored",
      model: "m",
      overviews: {
        en: localized("english", "Needs an API key."),
        "zh-CN": localized("简体"),
        "zh-TW": localized("繁體"),
      },
    });
    await data.db
      .update(data.skillVersionOverviews)
      .set({ hidden: true })
      .where(
        sql`${data.skillVersionOverviews.skillVersionId} = ${f.versionId} and ${data.skillVersionOverviews.locale} = 'zh-TW'`,
      );
    const zhCN = await repo.readOverviews({
      versionIds: [f.versionId],
      locale: "zh-CN",
    });
    expect(zhCN.get(f.versionId)?.locale).toBe("zh-CN");
    expect(zhCN.get(f.versionId)?.overview.cautions).toBeNull();
    const zhTW = await repo.readOverviews({
      versionIds: [f.versionId],
      locale: "zh-TW",
    });
    expect(zhTW.get(f.versionId)?.locale).toBe("en");
    expect(zhTW.get(f.versionId)?.overview.cautions).toBe("Needs an API key.");
    expect(
      (await repo.readOverviewLocales([f.versionId])).get(f.versionId),
    ).toEqual(["en", "zh-CN"]);
    expect(await repo.deleteOverviews(f.versionId)).toBe(3);
  });

  test("interrupted requests carry the kind's entity id", async () => {
    const repo = repository();
    const f = await claimed(repo);
    await data.db
      .update(data.skillVersionAnalysis)
      .set({ updatedAt: sql`now() - interval '10 minutes'` })
      .where(eq(data.skillVersionAnalysis.skillVersionId, f.versionId));
    expect(await repo.findInterrupted()).toContainEqual({
      versionId: f.versionId,
      parentId: f.parentId,
      requestId: f.requestId,
      force: false,
    });
  });
});
