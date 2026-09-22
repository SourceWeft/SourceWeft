import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  db,
  skillDefinitions,
  skillVersions,
  skillVersionAnalysis,
  skillVersionOverviews,
  skillDefinitionCategories,
  skillCategories,
  type SkillOverviewJson,
  type SkillOverviewLocale,
} from "@sourceweft/db";
import { recordSkillMarketEvent } from "./events";
import { skillCategoryDefinitions, skillCategoryId } from "./taxonomy";
import {
  SKILL_ANALYSIS_PROMPT_VERSION,
  SKILL_ANALYSIS_TAXONOMY_VERSION,
} from "./overview-prompt";

type SkillClassification = NonNullable<
  typeof skillVersionAnalysis.$inferSelect.classification
>;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const locales = ["en", "zh-CN", "zh-TW"] as const;

export async function readSkillAnalysis(skillVersionId: string) {
  const [row] = await db
    .select()
    .from(skillVersionAnalysis)
    .where(eq(skillVersionAnalysis.skillVersionId, skillVersionId));
  return row ?? null;
}

/** Reserve before enqueue. A new request fences an older running worker. */
export async function requestSkillAnalysis(
  skillVersionId: string,
  force: boolean,
) {
  const requestId = randomUUID();
  const rows = await db
    .insert(skillVersionAnalysis)
    .values({ skillVersionId, requestId, status: "pending", force })
    .onConflictDoUpdate({
      target: skillVersionAnalysis.skillVersionId,
      set: {
        requestId,
        status: "pending",
        force,
        error: null,
        updatedAt: new Date(),
      },
      ...(force ? {} : { setWhere: sql`false` }),
    })
    .returning();
  return rows[0] ?? null;
}

export async function claimSkillAnalysis(
  skillVersionId: string,
  requestId: string,
) {
  const rows = await db
    .update(skillVersionAnalysis)
    .set({ status: "running", error: null, updatedAt: new Date() })
    .where(
      and(
        eq(skillVersionAnalysis.skillVersionId, skillVersionId),
        eq(skillVersionAnalysis.requestId, requestId),
        inArray(skillVersionAnalysis.status, ["pending", "running"]),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function failSkillAnalysis(
  skillVersionId: string,
  requestId: string,
  error: string,
  retry: boolean,
) {
  await db
    .update(skillVersionAnalysis)
    .set({
      status: retry ? "pending" : "failed",
      error: error.slice(0, 500),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(skillVersionAnalysis.skillVersionId, skillVersionId),
        eq(skillVersionAnalysis.requestId, requestId),
        inArray(skillVersionAnalysis.status, ["pending", "running"]),
      ),
    );
}

/** Only complete, versioned results are reusable. Never borrow legacy OpenCC rows. */
export async function findCachedSkillAnalysis(
  resultKey: string,
  skillVersionId: string,
) {
  // One statement = one MVCC snapshot; classification and locale content
  // cannot come from different generations during concurrent regeneration.
  const rows = await db
    .select({ analysis: skillVersionAnalysis, overview: skillVersionOverviews })
    .from(skillVersionAnalysis)
    .innerJoin(
      skillVersionOverviews,
      eq(
        skillVersionOverviews.skillVersionId,
        skillVersionAnalysis.skillVersionId,
      ),
    )
    .where(
      and(
        eq(skillVersionAnalysis.resultKey, resultKey),
        ne(skillVersionAnalysis.skillVersionId, skillVersionId),
        inArray(skillVersionAnalysis.status, ["ready", "needs-review"]),
        eq(skillVersionAnalysis.promptVersion, SKILL_ANALYSIS_PROMPT_VERSION),
        eq(
          skillVersionAnalysis.taxonomyVersion,
          SKILL_ANALYSIS_TAXONOMY_VERSION,
        ),
      ),
    )
    .orderBy(skillVersionAnalysis.skillVersionId)
    .limit(30);
  const groups = new Map<string, typeof rows>();
  for (const row of rows)
    groups.set(row.analysis.skillVersionId, [
      ...(groups.get(row.analysis.skillVersionId) ?? []),
      row,
    ]);
  for (const group of groups.values()) {
    const source = group[0]!.analysis;
    if (
      !source.classification ||
      !locales.every((locale) =>
        group.some((row) => row.overview.locale === locale),
      ) ||
      group.some((row) => row.overview.hidden)
    )
      continue;
    return {
      classification: source.classification,
      model: group[0]!.overview.model,
      overviews: Object.fromEntries(
        group.map((row) => [row.overview.locale, row.overview.overview]),
      ) as Record<SkillOverviewLocale, SkillOverviewJson>,
    };
  }
  return null;
}

/** Caller holds definition lock. Human choices always win over automatic jobs. */
export async function applyAnalysisCategories(
  tx: Tx,
  skillId: string,
  skillVersionId: string,
  classification: SkillClassification,
  actorUserId?: string,
) {
  if (classification.status !== "ready" || !classification.primary)
    return false;
  const [definition] = await tx
    .select()
    .from(skillDefinitions)
    .where(eq(skillDefinitions.id, skillId))
    .for("update");
  if (!definition || (!actorUserId && definition.categoriesSetBy === "admin"))
    return false;
  const [version] = await tx
    .select()
    .from(skillVersions)
    .where(
      and(
        eq(skillVersions.id, skillVersionId),
        eq(skillVersions.skillId, skillId),
        eq(skillVersions.isCurrent, true),
        eq(skillVersions.status, "published"),
      ),
    );
  if (!version) return false;
  const slugs = [
    classification.primary,
    ...(classification.secondary ? [classification.secondary] : []),
  ];
  if (
    slugs.some((slug) => !skillCategoryDefinitions.some((c) => c.slug === slug))
  )
    throw new Error("Invalid analysis category");
  await tx
    .insert(skillCategories)
    .values(
      skillCategoryDefinitions.map((c, sortOrder) => ({
        ...c,
        id: skillCategoryId(c.slug),
        sortOrder,
      })),
    )
    .onConflictDoNothing();
  const before = await tx
    .select({ slug: skillCategories.slug })
    .from(skillDefinitionCategories)
    .innerJoin(
      skillCategories,
      eq(skillCategories.id, skillDefinitionCategories.categoryId),
    )
    .where(eq(skillDefinitionCategories.skillId, skillId));
  const from = before.map((row) => row.slug);
  if (
    definition.categoriesSetBy === "ai" &&
    [...from].sort().join() === [...slugs].sort().join()
  )
    return false;
  await tx
    .delete(skillDefinitionCategories)
    .where(eq(skillDefinitionCategories.skillId, skillId));
  await tx
    .insert(skillDefinitionCategories)
    .values(
      slugs.map((slug) => ({ skillId, categoryId: skillCategoryId(slug) })),
    );
  await tx
    .update(skillDefinitions)
    .set({ categoriesSetBy: "ai", updatedAt: new Date() })
    .where(eq(skillDefinitions.id, skillId));
  await recordSkillMarketEvent(
    {
      skillId,
      actorKind: actorUserId ? "admin" : "system",
      actorUserId,
      action: "categories.reinferred",
      detail: {
        source: "ai",
        skillVersionId,
        categorySlugs: { from, to: slugs },
        categoriesSetBy: { from: definition.categoriesSetBy, to: "ai" },
      },
    },
    tx,
  );
  return true;
}

/** Publish all locales + classification atomically, fenced against regeneration and version changes. */
export async function publishSkillAnalysis(input: {
  skillId: string;
  skillVersionId: string;
  requestId: string;
  resultKey: string;
  bundleSha256: string;
  model: string;
  modelConfigurationKey?: string;
  classification: SkillClassification;
  overviews: Record<SkillOverviewLocale, SkillOverviewJson>;
}) {
  return db.transaction(async (tx) => {
    // Lock order is definition -> version -> analysis throughout publication.
    const [definition] = await tx
      .select()
      .from(skillDefinitions)
      .where(eq(skillDefinitions.id, input.skillId))
      .for("update");
    const [version] = await tx
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.id, input.skillVersionId))
      .for("update");
    const [state] = await tx
      .select()
      .from(skillVersionAnalysis)
      .where(eq(skillVersionAnalysis.skillVersionId, input.skillVersionId))
      .for("update");
    if (
      !state ||
      state.requestId !== input.requestId ||
      state.status !== "running"
    )
      return false;
    if (
      !definition ||
      definition.visibility !== "public" ||
      definition.status !== "active" ||
      definition.sourceType !== "registry_github" ||
      !version?.isCurrent ||
      version.status !== "published" ||
      version.skillId !== input.skillId
    ) {
      await tx
        .update(skillVersionAnalysis)
        .set({
          status: "failed",
          error: "Version is no longer eligible",
          updatedAt: new Date(),
        })
        .where(eq(skillVersionAnalysis.skillVersionId, input.skillVersionId));
      return false;
    }
    if (!locales.every((locale) => input.overviews[locale]))
      throw new Error("Incomplete overview locales");
    const hiddenRows = await tx
      .select({ hidden: skillVersionOverviews.hidden })
      .from(skillVersionOverviews)
      .where(eq(skillVersionOverviews.skillVersionId, input.skillVersionId));
    const hidden = hiddenRows.some((row) => row.hidden);
    await tx
      .insert(skillVersionOverviews)
      .values(
        locales.map((locale) => ({
          skillVersionId: input.skillVersionId,
          locale,
          bundleSha256: input.bundleSha256,
          overview: input.overviews[locale],
          model: input.model,
          hidden,
          generatedAt: new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: [
          skillVersionOverviews.skillVersionId,
          skillVersionOverviews.locale,
        ],
        set: {
          bundleSha256: sql`excluded.bundle_sha256`,
          overview: sql`excluded.overview`,
          model: sql`excluded.model`,
          generatedAt: sql`excluded.generated_at`,
        },
      });
    await tx
      .update(skillVersionAnalysis)
      .set({
        status: input.classification.status,
        resultKey: input.resultKey,
        modelConfigurationKey: input.modelConfigurationKey ?? null,
        classification: input.classification,
        promptVersion: SKILL_ANALYSIS_PROMPT_VERSION,
        taxonomyVersion: SKILL_ANALYSIS_TAXONOMY_VERSION,
        force: false,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(skillVersionAnalysis.skillVersionId, input.skillVersionId));
    await applyAnalysisCategories(
      tx,
      input.skillId,
      input.skillVersionId,
      input.classification,
    );
    return true;
  });
}

/** Recover the DB-reserved requests if a process died before enqueueing Redis. */
export async function findInterruptedSkillAnalyses() {
  return db
    .select({
      skillVersionId: skillVersionAnalysis.skillVersionId,
      requestId: skillVersionAnalysis.requestId,
      force: skillVersionAnalysis.force,
      skillId: skillVersions.skillId,
    })
    .from(skillVersionAnalysis)
    .innerJoin(
      skillVersions,
      eq(skillVersions.id, skillVersionAnalysis.skillVersionId),
    )
    .where(
      and(
        inArray(skillVersionAnalysis.status, ["pending", "running"]),
        sql`${skillVersionAnalysis.updatedAt} < now() - interval '5 minutes'`,
      ),
    )
    .orderBy(skillVersionAnalysis.updatedAt)
    .limit(20);
}
