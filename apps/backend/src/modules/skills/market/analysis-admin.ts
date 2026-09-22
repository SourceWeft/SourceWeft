import { skillAnalysisQualityApproved } from "./analysis-quality";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  skillDefinitions,
  skillVersions,
  skillVersionAnalysis,
  skillVersionOverviews,
} from "@sourceweft/db";
import { ContentError } from "../../content/errors";
import {
  SKILL_ANALYSIS_PROMPT_VERSION,
  SKILL_ANALYSIS_TAXONOMY_VERSION,
} from "./overview-prompt";
import { listSkillCategorySlugs } from "./listing";
import { regenerateSkillOverview } from "./overview-admin";

/** Cursor is the last definition ID; preview never changes data or invokes a model. */
export async function previewSkillAnalysis(cursor?: string) {
  const rows = await db
    .select({
      skillId: skillDefinitions.id,
      skillVersionId: skillVersions.id,
      name: skillDefinitions.displayName,
      categoriesSource: skillDefinitions.categoriesSetBy,
      analysis: skillVersionAnalysis,
      hasOverview: sql<boolean>`exists(select 1 from ${skillVersionOverviews} o where o.skill_version_id = ${skillVersions.id})`,
    })
    .from(skillDefinitions)
    .innerJoin(
      skillVersions,
      and(
        eq(skillVersions.skillId, skillDefinitions.id),
        eq(skillVersions.isCurrent, true),
        eq(skillVersions.status, "published"),
      ),
    )
    .leftJoin(
      skillVersionAnalysis,
      eq(skillVersionAnalysis.skillVersionId, skillVersions.id),
    )
    .where(
      and(
        eq(skillDefinitions.sourceType, "registry_github"),
        eq(skillDefinitions.visibility, "public"),
        eq(skillDefinitions.status, "active"),
        cursor ? sql`${skillDefinitions.id} > ${cursor}` : undefined,
      ),
    )
    .orderBy(skillDefinitions.id)
    .limit(21);
  const page = rows.slice(0, 20);
  const categories = await listSkillCategorySlugs(
    page.map((row) => row.skillId),
  );
  return {
    qualityApproved: await skillAnalysisQualityApproved(),
    items: page.map((row) => ({
      skillId: row.skillId,
      skillVersionId: row.skillVersionId,
      name: row.name,
      categoriesSource: row.categoriesSource,
      status: row.analysis?.status ?? (row.hasOverview ? "legacy" : "missing"),
      categories: categories.get(row.skillId) ?? [],
      suggestedCategories: [
        row.analysis?.classification?.primary,
        row.analysis?.classification?.secondary,
      ].filter((x): x is string => !!x),
      error: row.analysis?.error ?? null,
      stale:
        row.analysis?.promptVersion !== SKILL_ANALYSIS_PROMPT_VERSION ||
        row.analysis?.taxonomyVersion !== SKILL_ANALYSIS_TAXONOMY_VERSION,
    })),
    nextCursor: rows.length > 20 ? page.at(-1)!.skillId : null,
  };
}

export async function enqueueSkillAnalysisBatch(
  skillVersionIds: string[],
  actorUserId: string,
) {
  if (!(await skillAnalysisQualityApproved()))
    throw new ContentError(
      409,
      "SKILL_ANALYSIS_QUALITY_REQUIRED",
      "Complete the reviewed accuracy evaluation before bulk migration",
    );
  let queued = 0,
    skipped = 0;
  for (const versionId of [...new Set(skillVersionIds)]) {
    const [row] = await db
      .select({
        id: skillDefinitions.id,
        source: skillDefinitions.categoriesSetBy,
      })
      .from(skillVersions)
      .innerJoin(
        skillDefinitions,
        eq(skillDefinitions.id, skillVersions.skillId),
      )
      .where(
        and(
          eq(skillVersions.id, versionId),
          eq(skillVersions.isCurrent, true),
          eq(skillVersions.status, "published"),
          eq(skillDefinitions.visibility, "public"),
          eq(skillDefinitions.status, "active"),
          eq(skillDefinitions.sourceType, "registry_github"),
        ),
      );
    if (!row || row.source === "admin") {
      skipped++;
      continue;
    }
    // Compare expected version again at request time, not merely in the preview.
    const result = await regenerateSkillOverview({
      skillId: row.id,
      actorUserId,
      expectedVersionId: versionId,
    });
    if (result?.queued) queued++;
    else skipped++;
  }
  return { queued, skipped };
}
