import { and, eq } from "drizzle-orm";
import {
  db,
  skillDefinitions,
  skillVersions,
  skillVersionAnalysis,
  skillVersionOverviews,
  skillDefinitionCategories,
  skillCategories,
  type SkillAnalysisClassification,
  type SkillOverviewJson,
  type SkillOverviewLocale,
} from "@sourceweft/db";
import {
  createCatalogOverviewRepository,
  type Tx,
} from "../../catalog-overview/repository";
import { recordSkillMarketEvent } from "./events";
import { skillCategoryDefinitions, skillCategoryId } from "./taxonomy";
import {
  SKILL_ANALYSIS_PROMPT_VERSION,
  SKILL_ANALYSIS_TAXONOMY_VERSION,
} from "./overview-prompt";

/**
 * AI analysis of skills on the catalog overview engine's repository: the
 * generation state (`skill_version_analysis`) and atomic publication into
 * `skill_version_overviews`. What is skill-specific is here: which version
 * may be published, and how its categories are applied.
 */

type SkillClassification = SkillAnalysisClassification;

/**
 * Locks the definition, then the version, and says whether the version is
 * still the public, active GitHub skill's current published one.
 */
async function lockSkillVersion(
  tx: Tx,
  target: { versionId: string; parentId: string },
): Promise<boolean> {
  const [definition] = await tx
    .select()
    .from(skillDefinitions)
    .where(eq(skillDefinitions.id, target.parentId))
    .for("update");
  const [version] = await tx
    .select()
    .from(skillVersions)
    .where(eq(skillVersions.id, target.versionId))
    .for("update");
  return Boolean(
    definition &&
    definition.visibility === "public" &&
    definition.status === "active" &&
    definition.sourceType === "registry_github" &&
    version?.isCurrent &&
    version.status === "published" &&
    version.skillId === target.parentId,
  );
}

/** The engine's repository on the skill tables; overview rows are read through it too. */
export const skillOverviewRepository = createCatalogOverviewRepository<
  typeof skillVersionAnalysis,
  SkillClassification
>({
  overviews: {
    table: skillVersionOverviews,
    versionId: skillVersionOverviews.skillVersionId,
    fingerprint: skillVersionOverviews.bundleSha256,
  },
  analysis: {
    table: skillVersionAnalysis,
    versionId: skillVersionAnalysis.skillVersionId,
  },
  versions: {
    table: skillVersions,
    id: skillVersions.id,
    parentId: skillVersions.skillId,
  },
  promptVersion: SKILL_ANALYSIS_PROMPT_VERSION,
  taxonomyVersion: SKILL_ANALYSIS_TAXONOMY_VERSION,
  lockTarget: lockSkillVersion,
  applyCategories: (tx, target, classification) =>
    applyAnalysisCategories(
      tx,
      target.parentId,
      target.versionId,
      classification,
    ),
});

const repository = skillOverviewRepository;

export async function readSkillAnalysis(skillVersionId: string) {
  return repository.read(skillVersionId);
}

/** Reserve before enqueue. A new request fences an older running worker. */
export async function requestSkillAnalysis(
  skillVersionId: string,
  force: boolean,
) {
  return repository.request(skillVersionId, force);
}

export async function claimSkillAnalysis(
  skillVersionId: string,
  requestId: string,
) {
  return repository.claim(skillVersionId, requestId);
}

export async function failSkillAnalysis(
  skillVersionId: string,
  requestId: string,
  error: string,
  retry: boolean,
) {
  await repository.fail(skillVersionId, requestId, error, retry);
}

/** Only complete, versioned results are reusable. Never borrow legacy OpenCC rows. */
export async function findCachedSkillAnalysis(
  resultKey: string,
  skillVersionId: string,
): Promise<{
  classification: SkillClassification;
  model: string;
  overviews: Record<SkillOverviewLocale, SkillOverviewJson>;
} | null> {
  return repository.findCached(resultKey, skillVersionId);
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
  return repository.publish({
    parentId: input.skillId,
    versionId: input.skillVersionId,
    requestId: input.requestId,
    resultKey: input.resultKey,
    fingerprint: input.bundleSha256,
    model: input.model,
    modelConfigurationKey: input.modelConfigurationKey,
    classification: input.classification,
    overviews: input.overviews,
  });
}

/** Recover the DB-reserved requests if a process died before enqueueing Redis. */
export async function findInterruptedSkillAnalyses() {
  const rows = await repository.findInterrupted();
  return rows.map((row) => ({
    skillVersionId: row.versionId,
    requestId: row.requestId,
    force: row.force,
    skillId: row.parentId,
  }));
}
