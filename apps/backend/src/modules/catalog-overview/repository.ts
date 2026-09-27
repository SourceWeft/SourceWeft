import { randomUUID } from "node:crypto";
import { and, eq, getTableColumns, inArray, ne, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import {
  CATALOG_OVERVIEW_LOCALES,
  db,
  type CatalogAnalysisStatus,
  type CatalogClassificationOutcome,
  type CatalogOverviewJson,
  type CatalogOverviewLocale,
} from "@sourceweft/db";
import type { CachedOverview } from "./types";

/**
 * Storage for AI overviews on a kind's own two tables, built from the shared
 * column definitions (`catalogOverviewColumns` / `catalogAnalysisColumns` in
 * `@sourceweft/db`). Nothing here names a kind's table: the kind hands its
 * tables in, with the two things only it knows — how to lock and re-check
 * its entity before publishing, and how its categories are applied.
 */

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A table built with `catalogOverviewColumns`. */
export type CatalogOverviewTable = PgTable & {
  locale: AnyPgColumn;
  overview: AnyPgColumn;
  model: AnyPgColumn;
  hidden: AnyPgColumn;
  generatedAt: AnyPgColumn;
};

/** A table built with `catalogAnalysisColumns`. */
export type CatalogAnalysisTable = PgTable & {
  requestId: AnyPgColumn;
  status: AnyPgColumn;
  force: AnyPgColumn;
  resultKey: AnyPgColumn;
  modelConfigurationKey: AnyPgColumn;
  promptVersion: AnyPgColumn;
  taxonomyVersion: AnyPgColumn;
  classification: AnyPgColumn;
  error: AnyPgColumn;
  updatedAt: AnyPgColumn;
};

/** The version a publication is for, with its kind's entity. */
export type CatalogOverviewTarget = { versionId: string; parentId: string };

export type CatalogOverviewRepositoryConfig<
  TAnalysis extends CatalogAnalysisTable,
  TClassification extends CatalogClassificationOutcome,
> = {
  overviews: {
    table: CatalogOverviewTable;
    // The version key column (the foreign key to the kind's versions).
    versionId: AnyPgColumn;
    // The input fingerprint column (`catalogOverviewColumns`' `fingerprint`).
    fingerprint: AnyPgColumn;
  };
  analysis: { table: TAnalysis; versionId: AnyPgColumn };
  // The kind's versions table, to find which entity a version belongs to.
  versions: { table: PgTable; id: AnyPgColumn; parentId: AnyPgColumn };
  // Results under other versions are reused only when written by these.
  promptVersion: string;
  taxonomyVersion: string;
  /**
   * Locks the kind's entity rows (entity first, then version: the analysis
   * row is always locked after them) and says whether the version may still
   * be published: public, current, and still this entity's.
   */
  lockTarget: (tx: Tx, target: CatalogOverviewTarget) => Promise<boolean>;
  /** Applies the classification's categories under the kind's ownership rules. */
  applyCategories: (
    tx: Tx,
    target: CatalogOverviewTarget,
    classification: TClassification,
  ) => Promise<unknown>;
};

export type PublishCatalogOverviewInput<TClassification> =
  CatalogOverviewTarget & {
    requestId: string;
    resultKey: string;
    fingerprint: string;
    model: string;
    modelConfigurationKey?: string;
    classification: TClassification;
    overviews: Record<CatalogOverviewLocale, CatalogOverviewJson>;
  };

export type CatalogOverviewRead = {
  overview: CatalogOverviewJson;
  locale: CatalogOverviewLocale;
  generatedAt: Date;
};

// Statuses a request is still live in; failure and fencing only touch these.
const LIVE_STATUSES: CatalogAnalysisStatus[] = ["pending", "running"];

/** The TypeScript key a column has on its table (inserts are keyed by it). */
function keyOf(table: PgTable, column: AnyPgColumn): string {
  const entry = Object.entries(getTableColumns(table)).find(
    ([, candidate]) => candidate === column,
  );
  if (!entry) throw new Error(`Column ${column.name} is not on this table`);
  return entry[0];
}

/** An overview as read back; rows written before `cautions` have it null. */
function readOverviewJson(value: CatalogOverviewJson): CatalogOverviewJson {
  return { ...value, cautions: value.cautions ?? null };
}

export function createCatalogOverviewRepository<
  TAnalysis extends CatalogAnalysisTable,
  TClassification extends CatalogClassificationOutcome,
>(config: CatalogOverviewRepositoryConfig<TAnalysis, TClassification>) {
  type AnalysisRow = TAnalysis["$inferSelect"];
  const overviews = config.overviews.table;
  const analysis = config.analysis.table;
  const overviewVersionId = config.overviews.versionId;
  const analysisVersionId = config.analysis.versionId;
  const overviewVersionKey = keyOf(overviews, overviewVersionId);
  const fingerprintKey = keyOf(overviews, config.overviews.fingerprint);
  const analysisVersionKey = keyOf(analysis, analysisVersionId);

  // -------------------------------------------------------------------------
  // Generation state (the analysis row)
  // -------------------------------------------------------------------------

  async function read(versionId: string): Promise<AnalysisRow | null> {
    const [row] = await db
      .select()
      .from(analysis as PgTable)
      .where(eq(analysisVersionId, versionId));
    return (row as AnalysisRow | undefined) ?? null;
  }

  /** Reserve before enqueue. A new forced request fences an older running worker. */
  async function request(
    versionId: string,
    force: boolean,
  ): Promise<AnalysisRow | null> {
    const requestId = randomUUID();
    const rows = await db
      .insert(analysis as PgTable)
      .values({
        [analysisVersionKey]: versionId,
        requestId,
        status: "pending",
        force,
      })
      .onConflictDoUpdate({
        target: analysisVersionId,
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
    return (rows[0] as AnalysisRow | undefined) ?? null;
  }

  async function claim(
    versionId: string,
    requestId: string,
  ): Promise<AnalysisRow | null> {
    const rows = await db
      .update(analysis as PgTable)
      .set({ status: "running", error: null, updatedAt: new Date() })
      .where(
        and(
          eq(analysisVersionId, versionId),
          eq(analysis.requestId, requestId),
          inArray(analysis.status, LIVE_STATUSES),
        ),
      )
      .returning();
    return (rows[0] as AnalysisRow | undefined) ?? null;
  }

  async function fail(
    versionId: string,
    requestId: string,
    error: string,
    retry: boolean,
  ): Promise<void> {
    await db
      .update(analysis as PgTable)
      .set({
        status: retry ? "pending" : "failed",
        error: error.slice(0, 500),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(analysisVersionId, versionId),
          eq(analysis.requestId, requestId),
          inArray(analysis.status, LIVE_STATUSES),
        ),
      );
  }

  /** Only complete, versioned results are reusable. */
  async function findCached(
    resultKey: string,
    versionId: string,
  ): Promise<CachedOverview<TClassification> | null> {
    // One statement = one MVCC snapshot; classification and locale content
    // cannot come from different generations during concurrent regeneration.
    const rows = (await db
      .select({ analysis, overview: overviews })
      .from(analysis as PgTable)
      .innerJoin(overviews, eq(overviewVersionId, analysisVersionId))
      .where(
        and(
          eq(analysis.resultKey, resultKey),
          ne(analysisVersionId, versionId),
          inArray(analysis.status, ["ready", "needs-review"]),
          eq(analysis.promptVersion, config.promptVersion),
          eq(analysis.taxonomyVersion, config.taxonomyVersion),
        ),
      )
      .orderBy(analysisVersionId)
      .limit(30)) as unknown as Array<{
      analysis: Record<string, unknown> & {
        classification: TClassification | null;
      };
      overview: {
        locale: CatalogOverviewLocale;
        overview: CatalogOverviewJson;
        model: string;
        hidden: boolean;
      };
    }>;
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const id = String(row.analysis[analysisVersionKey]);
      groups.set(id, [...(groups.get(id) ?? []), row]);
    }
    for (const group of groups.values()) {
      const source = group[0]!.analysis;
      if (
        !source.classification ||
        !CATALOG_OVERVIEW_LOCALES.every((locale) =>
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
        ) as Record<CatalogOverviewLocale, CatalogOverviewJson>,
      };
    }
    return null;
  }

  /**
   * Publishes every locale and the classification atomically, fenced against
   * a newer request and against the version changing under it. False when
   * fenced or no longer eligible (the latter recorded as a failure).
   */
  async function publish(
    input: PublishCatalogOverviewInput<TClassification>,
  ): Promise<boolean> {
    return db.transaction(async (tx) => {
      // Lock order is entity -> version -> analysis throughout publication.
      const eligible = await config.lockTarget(tx, input);
      const [state] = (await tx
        .select({ requestId: analysis.requestId, status: analysis.status })
        .from(analysis as PgTable)
        .where(eq(analysisVersionId, input.versionId))
        .for("update")) as Array<{
        requestId: string;
        status: CatalogAnalysisStatus;
      }>;
      if (
        !state ||
        state.requestId !== input.requestId ||
        state.status !== "running"
      )
        return false;
      if (!eligible) {
        await tx
          .update(analysis as PgTable)
          .set({
            status: "failed",
            error: "Version is no longer eligible",
            updatedAt: new Date(),
          })
          .where(eq(analysisVersionId, input.versionId));
        return false;
      }
      if (!CATALOG_OVERVIEW_LOCALES.every((locale) => input.overviews[locale]))
        throw new Error("Incomplete overview locales");
      const hiddenRows = (await tx
        .select({ hidden: overviews.hidden })
        .from(overviews)
        .where(eq(overviewVersionId, input.versionId))) as Array<{
        hidden: boolean;
      }>;
      // An admin's hide survives regeneration.
      const hidden = hiddenRows.some((row) => row.hidden);
      await tx
        .insert(overviews)
        .values(
          CATALOG_OVERVIEW_LOCALES.map((locale) => ({
            [overviewVersionKey]: input.versionId,
            locale,
            [fingerprintKey]: input.fingerprint,
            overview: input.overviews[locale],
            model: input.model,
            hidden,
            generatedAt: new Date(),
          })),
        )
        .onConflictDoUpdate({
          target: [overviewVersionId, overviews.locale],
          set: {
            [fingerprintKey]: sql.raw(
              `excluded.${config.overviews.fingerprint.name}`,
            ),
            overview: sql`excluded.overview`,
            model: sql`excluded.model`,
            generatedAt: sql`excluded.generated_at`,
          },
        });
      await tx
        .update(analysis as PgTable)
        .set({
          status: input.classification.status,
          resultKey: input.resultKey,
          modelConfigurationKey: input.modelConfigurationKey ?? null,
          classification: input.classification,
          promptVersion: config.promptVersion,
          taxonomyVersion: config.taxonomyVersion,
          force: false,
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(analysisVersionId, input.versionId));
      await config.applyCategories(tx, input, input.classification);
      return true;
    });
  }

  /** Reserved requests left behind if a process died before enqueueing. */
  async function findInterrupted(): Promise<
    Array<CatalogOverviewTarget & { requestId: string; force: boolean }>
  > {
    return (await db
      .select({
        versionId: analysisVersionId,
        requestId: analysis.requestId,
        force: analysis.force,
        parentId: config.versions.parentId,
      })
      .from(analysis as PgTable)
      .innerJoin(
        config.versions.table,
        eq(config.versions.id, analysisVersionId),
      )
      .where(
        and(
          inArray(analysis.status, LIVE_STATUSES),
          sql`${analysis.updatedAt} < now() - interval '5 minutes'`,
        ),
      )
      .orderBy(analysis.updatedAt)
      .limit(20)) as Array<
      CatalogOverviewTarget & { requestId: string; force: boolean }
    >;
  }

  // -------------------------------------------------------------------------
  // Overview rows
  // -------------------------------------------------------------------------

  /**
   * Writes one version's overviews, one row per locale. A row already there
   * is replaced and `hidden` is kept.
   */
  async function storeOverviews(input: {
    versionId: string;
    fingerprint: string;
    model: string;
    overviews: Record<CatalogOverviewLocale, CatalogOverviewJson>;
    generatedAt?: Date;
  }): Promise<void> {
    const generatedAt = input.generatedAt ?? new Date();
    await db
      .insert(overviews)
      .values(
        CATALOG_OVERVIEW_LOCALES.map((locale) => ({
          [overviewVersionKey]: input.versionId,
          locale,
          [fingerprintKey]: input.fingerprint,
          overview: input.overviews[locale],
          model: input.model,
          generatedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [overviewVersionId, overviews.locale],
        set: {
          [fingerprintKey]: sql.raw(
            `excluded.${config.overviews.fingerprint.name}`,
          ),
          overview: sql`excluded.overview`,
          model: sql`excluded.model`,
          generatedAt: sql`excluded.generated_at`,
        },
      });
  }

  /**
   * Each version's visible overview in `locale`, or in English when that one
   * is missing or hidden; versions with neither are absent from the map.
   */
  async function readOverviews(input: {
    versionIds: readonly string[];
    locale: CatalogOverviewLocale;
  }): Promise<Map<string, CatalogOverviewRead>> {
    const found = new Map<string, CatalogOverviewRead>();
    const ids = [...new Set(input.versionIds)];
    if (ids.length === 0) return found;
    const locales: CatalogOverviewLocale[] =
      input.locale === "en" ? ["en"] : [input.locale, "en"];
    const rows = (await db
      .select({
        versionId: overviewVersionId,
        locale: overviews.locale,
        overview: overviews.overview,
        generatedAt: overviews.generatedAt,
      })
      .from(overviews)
      .where(
        and(
          inArray(overviewVersionId, ids),
          inArray(overviews.locale, locales),
          eq(overviews.hidden, false),
        ),
      )) as Array<{
      versionId: string;
      locale: CatalogOverviewLocale;
      overview: CatalogOverviewJson;
      generatedAt: Date;
    }>;
    for (const row of rows) {
      const current = found.get(row.versionId);
      // The requested language wins over the fallback.
      if (!current || row.locale === input.locale) {
        found.set(row.versionId, {
          overview: readOverviewJson(row.overview),
          locale: row.locale,
          generatedAt: row.generatedAt,
        });
      }
    }
    return found;
  }

  /** Actual visible translations, never the English fallback; one query per batch. */
  async function readOverviewLocales(
    versionIds: readonly string[],
  ): Promise<Map<string, CatalogOverviewLocale[]>> {
    const result = new Map<string, CatalogOverviewLocale[]>();
    const ids = [...new Set(versionIds)];
    if (!ids.length) return result;
    const rows = (await db
      .select({ versionId: overviewVersionId, locale: overviews.locale })
      .from(overviews)
      .where(
        and(inArray(overviewVersionId, ids), eq(overviews.hidden, false)),
      )) as Array<{ versionId: string; locale: CatalogOverviewLocale }>;
    for (const row of rows) {
      const locales = result.get(row.versionId) ?? [];
      if (!locales.includes(row.locale)) locales.push(row.locale);
      result.set(row.versionId, locales);
    }
    for (const locales of result.values()) locales.sort();
    return result;
  }

  /** Removes a version's overviews; how many rows went. */
  async function deleteOverviews(versionId: string): Promise<number> {
    const deleted = await db
      .delete(overviews)
      .where(eq(overviewVersionId, versionId))
      .returning({ locale: overviews.locale });
    return deleted.length;
  }

  /** Hides or shows every locale of a version's overview; how many rows changed. */
  async function setOverviewsHidden(input: {
    versionId: string;
    hidden: boolean;
  }): Promise<number> {
    const updated = await db
      .update(overviews)
      .set({ hidden: input.hidden })
      .where(
        and(
          eq(overviewVersionId, input.versionId),
          ne(overviews.hidden, input.hidden),
        ),
      )
      .returning({ locale: overviews.locale });
    return updated.length;
  }

  return {
    read,
    request,
    claim,
    fail,
    findCached,
    publish,
    findInterrupted,
    storeOverviews,
    readOverviews,
    readOverviewLocales,
    deleteOverviews,
    setOverviewsHidden,
  };
}
