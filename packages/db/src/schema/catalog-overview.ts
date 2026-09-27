import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  primaryKey,
  text,
  timestamp,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sqlEnumList } from "./shared";

/**
 * Column definitions shared by every catalog kind's AI overview tables.
 *
 * Each kind keeps its own two tables, named with its own prefix
 * (`skill_version_overviews` / `skill_version_analysis`; later
 * `mcp_server_version_*`, `agent_*`), and builds them from these factories:
 * the kind declares only its version key column (the foreign key to its own
 * versions table, cascading on delete) and its own extra indexes. The
 * backend's overview engine (`apps/backend/src/modules/catalog-overview`)
 * reads and writes any table built this way.
 *
 * - The overview table holds one row per (version, locale): the AI-written
 *   text, never the author's own, which stays on the kind's entity.
 * - The analysis table holds one row per version: the durable generation
 *   state (`request_id` fences a stale worker) and the language-independent
 *   classification.
 */

export const CATALOG_OVERVIEW_LOCALES = ["en", "zh-CN", "zh-TW"] as const;
export type CatalogOverviewLocale = (typeof CATALOG_OVERVIEW_LOCALES)[number];

/** One version's overview in one language: plain text, written by a model. */
export type CatalogOverviewJson = {
  // One sentence, for cards.
  summary: string;
  whatItDoes: string;
  whenToUse: string;
  // Dependencies, scripts, credentials it needs; empty when none.
  requirements: string;
  // What to be careful about; rows written before this field existed have
  // none, which reads as null.
  cautions?: string | null;
  // Market category slugs the model suggested.
  suggestedCategories: string[];
};

export type CatalogAnalysisStatus =
  "pending" | "running" | "ready" | "failed" | "needs-review";

/** What every kind's classification says about itself: usable, or not. */
export type CatalogClassificationOutcome = {
  status: "ready" | "needs-review";
};

/**
 * The overview table's shared columns. `fingerprint` names the column that
 * identifies the input the overview was written from (skills keep their
 * historical `bundle_sha256`; new kinds use `input_sha256`).
 */
export function catalogOverviewColumns<
  const TFingerprint extends string,
>(fingerprint: { key: TFingerprint; name: string }) {
  const fingerprintColumn = () => text(fingerprint.name).notNull();
  return {
    locale: text("locale").$type<CatalogOverviewLocale>().notNull(),
    ...({ [fingerprint.key]: fingerprintColumn() } as Record<
      TFingerprint,
      ReturnType<typeof fingerprintColumn>
    >),
    overview: jsonb("overview").$type<CatalogOverviewJson>().notNull(),
    model: text("model").notNull(),
    // An admin hid it; the page falls back to the author's description.
    hidden: boolean("hidden").notNull().default(false),
    generatedAt: timestamp("generated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  };
}

/** The overview table's key (version, locale) and its locale check. */
export function catalogOverviewConstraints(
  tableName: string,
  table: { versionId: AnyPgColumn; locale: AnyPgColumn },
) {
  return [
    primaryKey({
      name: `${tableName}_pk`,
      columns: [table.versionId, table.locale],
    }),
    check(
      `${tableName}_locale_check`,
      sql`${table.locale} in (${sqlEnumList(CATALOG_OVERVIEW_LOCALES)})`,
    ),
  ];
}

/**
 * The analysis table's shared columns. Old output stays live while a newer
 * request runs; `request_id` fences stale workers.
 */
export function catalogAnalysisColumns<
  TClassification extends CatalogClassificationOutcome,
>() {
  return {
    requestId: text("request_id").notNull(),
    status: text("status").$type<CatalogAnalysisStatus>().notNull(),
    force: boolean("force").notNull().default(false),
    resultKey: text("result_key"),
    modelConfigurationKey: text("model_configuration_key"),
    promptVersion: text("prompt_version"),
    taxonomyVersion: text("taxonomy_version"),
    classification: jsonb("classification").$type<TClassification>(),
    error: text("error"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  };
}

/** The analysis table's status check and result-key index. */
export function catalogAnalysisConstraints(
  tableName: string,
  table: { status: AnyPgColumn; resultKey: AnyPgColumn },
) {
  return [
    check(
      `${tableName}_status_check`,
      sql`${table.status} in ('pending','running','ready','failed','needs-review')`,
    ),
    index(`${tableName}_result_idx`).on(table.resultKey),
  ];
}
