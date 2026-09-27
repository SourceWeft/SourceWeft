import { readSkillAnalysis } from "./analysis-repository";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  db,
  skillDefinitions,
  skillVersionFiles,
  skillVersionOverviews,
  skillVersionAnalysis,
  skillVersions,
  type SkillManifestJson,
  type SkillOverviewJson,
  type SkillOverviewLocale,
} from "@sourceweft/db";

/** Storage for AI overviews (`skill_version_overviews`). */

export const SKILL_OVERVIEW_LOCALES: readonly SkillOverviewLocale[] = [
  "en",
  "zh-CN",
  "zh-TW",
];

// ---------------------------------------------------------------------------
// Which skills get one
// ---------------------------------------------------------------------------

/**
 * A skill overviews are written for: public, active, imported from GitHub,
 * and its current published version — the one the market shows. Over
 * `skill_definitions` joined to `skill_versions`.
 */
export function skillOverviewEligibleCondition(): SQL {
  return and(
    eq(skillDefinitions.visibility, "public"),
    eq(skillDefinitions.sourceType, "registry_github"),
    eq(skillDefinitions.status, "active"),
    eq(skillVersions.status, "published"),
    eq(skillVersions.isCurrent, true),
  )!;
}

// What identical content is recognized by: the bundle's sha256, or for a
// version stored before bundles were, its content hash.
const bundleKey = sql<string>`coalesce(${skillVersions.bundleSha256}, ${skillVersions.contentHash})`;

const onVersion = eq(skillVersions.skillId, skillDefinitions.id);

const hasOverview = sql`exists (select 1 from ${skillVersionOverviews} where ${skillVersionOverviews.skillVersionId} = ${skillVersions.id})`;

export type SkillOverviewCandidate = {
  skillId: string;
  skillVersionId: string;
  bundleSha256: string;
};

/**
 * Eligible versions with no overview yet, most-installed first so the
 * market's front page is covered before its tail. `skillIds` narrows the
 * search (tests use it to stay within their own rows).
 */
export async function findSkillOverviewCandidates(input: {
  limit: number;
  skillIds?: readonly string[];
}): Promise<SkillOverviewCandidate[]> {
  return db
    .select({
      skillId: skillDefinitions.id,
      skillVersionId: skillVersions.id,
      bundleSha256: bundleKey,
    })
    .from(skillDefinitions)
    .innerJoin(skillVersions, onVersion)
    .where(
      and(
        skillOverviewEligibleCondition(),
        sql`not ${hasOverview}`,
        sql`not exists (select 1 from ${skillVersionAnalysis} a where a.skill_version_id = ${skillVersions.id})`,
        input.skillIds
          ? inArray(skillDefinitions.id, [...input.skillIds])
          : undefined,
      ),
    )
    .orderBy(
      desc(skillDefinitions.rankScore),
      desc(skillDefinitions.installCount),
      asc(skillDefinitions.id),
    )
    .limit(input.limit);
}

// ---------------------------------------------------------------------------
// The version being summarized
// ---------------------------------------------------------------------------

export type SkillOverviewSubject = {
  skillId: string;
  skillVersionId: string;
  slug: string;
  displayName: string;
  bundleSha256: string;
  eligible: boolean;
  isCurrent: boolean;
  skillMd: string | null;
  manifest: SkillManifestJson;
};

/** The version with what the prompt reads; null when there is no such version. */
export async function findSkillOverviewSubject(
  skillVersionId: string,
): Promise<SkillOverviewSubject | null> {
  const [row] = await db
    .select({
      skillId: skillDefinitions.id,
      skillVersionId: skillVersions.id,
      slug: skillDefinitions.slug,
      displayName: skillDefinitions.displayName,
      bundleSha256: bundleKey,
      eligible: sql<boolean>`${skillOverviewEligibleCondition()}`,
      isCurrent: skillVersions.isCurrent,
      skillMd: skillVersions.skillMd,
      manifest: skillVersions.manifestJson,
    })
    .from(skillVersions)
    .innerJoin(skillDefinitions, onVersion)
    .where(eq(skillVersions.id, skillVersionId))
    .limit(1);
  if (!row) return null;
  let skillMd = row.skillMd;
  if (skillMd === null) {
    // A version that does not carry SKILL.md in `skill_md` still has it as
    // its inline file row.
    const [file] = await db
      .select({ text: skillVersionFiles.contentText })
      .from(skillVersionFiles)
      .where(
        and(
          eq(skillVersionFiles.skillVersionId, skillVersionId),
          eq(skillVersionFiles.path, "SKILL.md"),
        ),
      )
      .limit(1);
    skillMd = file?.text ?? null;
  }
  return { ...row, eligible: Boolean(row.eligible), skillMd };
}

export async function countSkillOverviews(
  skillVersionId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(skillVersionOverviews)
    .where(eq(skillVersionOverviews.skillVersionId, skillVersionId));
  return Number(row?.count ?? 0);
}

/**
 * Writes one version's overviews, one row per locale. A row already there is
 * replaced — only a regenerate or a retry after a partial write gets here
 * with one — and `hidden` is kept.
 */
export async function storeSkillOverviews(input: {
  skillVersionId: string;
  bundleSha256: string;
  model: string;
  overviews: Record<SkillOverviewLocale, SkillOverviewJson>;
  generatedAt?: Date;
}): Promise<void> {
  const generatedAt = input.generatedAt ?? new Date();
  await db
    .insert(skillVersionOverviews)
    .values(
      SKILL_OVERVIEW_LOCALES.map((locale) => ({
        skillVersionId: input.skillVersionId,
        locale,
        bundleSha256: input.bundleSha256,
        overview: input.overviews[locale],
        model: input.model,
        generatedAt,
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
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

export type SkillOverviewRead = {
  overview: SkillOverviewJson;
  locale: SkillOverviewLocale;
  generatedAt: Date;
};

/**
 * Each version's visible overview in `locale`, or in English when that one
 * is missing or hidden; versions with neither are absent from the map.
 */
export async function readSkillOverviews(input: {
  skillVersionIds: readonly string[];
  locale: SkillOverviewLocale;
}): Promise<Map<string, SkillOverviewRead>> {
  const found = new Map<string, SkillOverviewRead>();
  const ids = [...new Set(input.skillVersionIds)];
  if (ids.length === 0) return found;
  const locales = input.locale === "en" ? ["en"] : [input.locale, "en"];
  const rows = await db
    .select({
      skillVersionId: skillVersionOverviews.skillVersionId,
      locale: skillVersionOverviews.locale,
      overview: skillVersionOverviews.overview,
      generatedAt: skillVersionOverviews.generatedAt,
    })
    .from(skillVersionOverviews)
    .where(
      and(
        inArray(skillVersionOverviews.skillVersionId, ids),
        inArray(skillVersionOverviews.locale, locales as SkillOverviewLocale[]),
        eq(skillVersionOverviews.hidden, false),
      ),
    );
  for (const row of rows) {
    const current = found.get(row.skillVersionId);
    // The requested language wins over the fallback.
    if (!current || row.locale === input.locale) {
      found.set(row.skillVersionId, {
        overview: row.overview,
        locale: row.locale,
        generatedAt: row.generatedAt,
      });
    }
  }
  return found;
}

/** Actual visible translations, never the English fallback; one query per batch. */
export async function readSkillOverviewLocales(
  skillVersionIds: readonly string[],
): Promise<Map<string, SkillOverviewLocale[]>> {
  const result = new Map<string, SkillOverviewLocale[]>();
  const ids = [...new Set(skillVersionIds)];
  if (!ids.length) return result;
  const rows = await db
    .select({
      versionId: skillVersionOverviews.skillVersionId,
      locale: skillVersionOverviews.locale,
    })
    .from(skillVersionOverviews)
    .where(
      and(
        inArray(skillVersionOverviews.skillVersionId, ids),
        eq(skillVersionOverviews.hidden, false),
      ),
    );
  for (const row of rows) {
    const locales = result.get(row.versionId) ?? [];
    if (!locales.includes(row.locale)) locales.push(row.locale);
    result.set(row.versionId, locales);
  }
  for (const locales of result.values()) locales.sort();
  return result;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export type SkillOverviewAdminState = {
  skillId: string;
  skillVersionId: string | null;
  bundleSha256: string | null;
  eligible: boolean;
  categoriesSource: "auto" | "admin" | "ai" | null;
  analysis: Awaited<ReturnType<typeof readSkillAnalysis>>;
  overviews: Array<{
    locale: SkillOverviewLocale;
    overview: SkillOverviewJson;
    model: string;
    hidden: boolean;
    generatedAt: Date;
  }>;
};

/**
 * A skill's current version and every overview row it has, hidden ones
 * included. Null when there is no such skill.
 */
export async function findSkillOverviewAdminState(
  skillId: string,
): Promise<SkillOverviewAdminState | null> {
  const [skill] = await db
    .select({
      id: skillDefinitions.id,
      categoriesSource: skillDefinitions.categoriesSetBy,
    })
    .from(skillDefinitions)
    .where(eq(skillDefinitions.id, skillId))
    .limit(1);
  if (!skill) return null;
  const [version] = await db
    .select({
      skillVersionId: skillVersions.id,
      bundleSha256: bundleKey,
      eligible: sql<boolean>`${skillOverviewEligibleCondition()}`,
    })
    .from(skillDefinitions)
    .innerJoin(skillVersions, onVersion)
    .where(
      and(
        eq(skillDefinitions.id, skillId),
        eq(skillVersions.isCurrent, true),
        eq(skillVersions.status, "published"),
      ),
    )
    .limit(1);
  if (!version) {
    return {
      skillId,
      skillVersionId: null,
      bundleSha256: null,
      eligible: false,
      categoriesSource: skill.categoriesSource,
      analysis: null,
      overviews: [],
    };
  }
  const rows = await db
    .select({
      locale: skillVersionOverviews.locale,
      overview: skillVersionOverviews.overview,
      model: skillVersionOverviews.model,
      hidden: skillVersionOverviews.hidden,
      generatedAt: skillVersionOverviews.generatedAt,
    })
    .from(skillVersionOverviews)
    .where(eq(skillVersionOverviews.skillVersionId, version.skillVersionId));
  const order = new Map(SKILL_OVERVIEW_LOCALES.map((locale, i) => [locale, i]));
  rows.sort((a, b) => (order.get(a.locale) ?? 9) - (order.get(b.locale) ?? 9));
  return {
    skillId,
    skillVersionId: version.skillVersionId,
    bundleSha256: version.bundleSha256,
    eligible: Boolean(version.eligible),
    categoriesSource: skill.categoriesSource,
    analysis: await readSkillAnalysis(version.skillVersionId),
    overviews: rows,
  };
}

/** Removes a version's overviews; how many rows went. */
export async function deleteSkillOverviews(
  skillVersionId: string,
): Promise<number> {
  const deleted = await db
    .delete(skillVersionOverviews)
    .where(eq(skillVersionOverviews.skillVersionId, skillVersionId))
    .returning({ locale: skillVersionOverviews.locale });
  return deleted.length;
}

/** Hides or shows every locale of a version's overview; how many rows changed. */
export async function setSkillOverviewsHidden(input: {
  skillVersionId: string;
  hidden: boolean;
}): Promise<number> {
  const updated = await db
    .update(skillVersionOverviews)
    .set({ hidden: input.hidden })
    .where(
      and(
        eq(skillVersionOverviews.skillVersionId, input.skillVersionId),
        ne(skillVersionOverviews.hidden, input.hidden),
      ),
    )
    .returning({ locale: skillVersionOverviews.locale });
  return updated.length;
}

/** How far the market's overviews have got. */
export async function countSkillOverviewCoverage(): Promise<{
  eligible: number;
  withOverview: number;
  hidden: number;
}> {
  const [row] = await db
    .select({
      eligible: sql<number>`count(*)::int`,
      withOverview: sql<number>`count(*) filter (where ${hasOverview})::int`,
      hidden: sql<number>`count(*) filter (where exists (select 1 from ${skillVersionOverviews} where ${skillVersionOverviews.skillVersionId} = ${skillVersions.id} and ${skillVersionOverviews.hidden}))::int`,
    })
    .from(skillDefinitions)
    .innerJoin(skillVersions, onVersion)
    .where(skillOverviewEligibleCondition());
  return {
    eligible: Number(row?.eligible ?? 0),
    withOverview: Number(row?.withOverview ?? 0),
    hidden: Number(row?.hidden ?? 0),
  };
}
