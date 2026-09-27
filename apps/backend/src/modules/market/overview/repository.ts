import { eq, sql } from "drizzle-orm";
import {
  CATALOG_OVERVIEW_LOCALES,
  db,
  mcpCategories,
  mcpServerCategories,
  mcpServers,
  mcpServerVersionAnalysis,
  mcpServerVersionOverviews,
  mcpServerVersions,
  workspaceMcpInstalls,
  type CatalogOverviewJson,
  type CatalogOverviewLocale,
  type McpAnalysisClassification,
} from "@sourceweft/db";
import {
  createCatalogOverviewRepository,
  type CatalogOverviewRead,
  type CatalogOverviewTarget,
  type Tx,
} from "../../catalog-overview/repository";
import type { OverviewStore } from "../../catalog-overview/types";
import { logger } from "../../../shared/logger";
import { upsertMcpCategories } from "../ingest/repository";
import { latestPublishedVersionOf } from "../latest-version";
import { getMcpCategoryDefinition } from "../parser/categories";
import {
  MCP_OVERVIEW_PROMPT_VERSION,
  MCP_OVERVIEW_TAXONOMY_VERSION,
} from "./prompt";
import type { McpOverviewAttempt, McpOverviewSourceRow } from "./source";

/**
 * Storage for MCP server AI overviews on the catalog overview engine's
 * repository (`mcp_server_version_overviews` / `mcp_server_version_analysis`),
 * and the MCP-specific SQL around it: which version may be published, how
 * its categories are applied, what the prompt reads, which versions the
 * scheduler queues, and the admin view.
 *
 * An overview is written for the version the catalog shows: the latest
 * published version (`latestPublishedVersionOf`) of a published, public
 * server.
 */

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

/**
 * Locks the server, then the version, and says whether the version may still
 * be published: the server is published and public, and the version is its
 * latest published one.
 */
async function lockMcpServerVersion(
  tx: Tx,
  target: CatalogOverviewTarget,
): Promise<boolean> {
  const [server] = await tx
    .select({ status: mcpServers.status, visibility: mcpServers.visibility })
    .from(mcpServers)
    .where(eq(mcpServers.id, target.parentId))
    .for("update");
  const [version] = await tx
    .select({
      serverId: mcpServerVersions.serverId,
      status: mcpServerVersions.status,
    })
    .from(mcpServerVersions)
    .where(eq(mcpServerVersions.id, target.versionId))
    .for("update");
  if (
    !server ||
    !version ||
    server.status !== "published" ||
    server.visibility !== "public" ||
    version.status !== "published" ||
    version.serverId !== target.parentId
  )
    return false;
  const latest = await tx.execute<{ id: string | null }>(
    sql`select ${latestPublishedVersionOf(target.parentId)} as "id"`,
  );
  return latest.rows[0]?.id === target.versionId;
}

/**
 * Applies a published classification to the server's categories and marks
 * them `ai`. A market admin's choice (`admin`) is never overwritten, and an
 * unchanged `ai` set is left alone. The caller holds the server lock.
 */
export async function applyMcpAnalysisCategories(
  tx: Tx,
  target: CatalogOverviewTarget,
  classification: McpAnalysisClassification,
): Promise<boolean> {
  if (classification.status !== "ready") return false;
  const slugs = [
    ...new Set(classification.categories.map((category) => category.slug)),
  ];
  if (slugs.length === 0) return false;
  if (slugs.some((slug) => !getMcpCategoryDefinition(slug)))
    throw new Error("Invalid analysis category");
  const [server] = await tx
    .select({ categoriesSetBy: mcpServers.categoriesSetBy })
    .from(mcpServers)
    .where(eq(mcpServers.id, target.parentId))
    .for("update");
  if (!server || server.categoriesSetBy === "admin") return false;
  const before = await tx
    .select({ slug: mcpCategories.slug })
    .from(mcpServerCategories)
    .innerJoin(
      mcpCategories,
      eq(mcpCategories.id, mcpServerCategories.categoryId),
    )
    .where(eq(mcpServerCategories.serverId, target.parentId));
  const from = before.map((row) => row.slug);
  if (
    server.categoriesSetBy === "ai" &&
    [...from].sort().join() === [...slugs].sort().join()
  )
    return false;
  const categoryIds = await upsertMcpCategories(tx, slugs);
  await tx
    .delete(mcpServerCategories)
    .where(eq(mcpServerCategories.serverId, target.parentId));
  await tx.insert(mcpServerCategories).values(
    categoryIds.map((categoryId) => ({
      serverId: target.parentId,
      categoryId,
    })),
  );
  await tx
    .update(mcpServers)
    .set({ categoriesSetBy: "ai", updatedAt: new Date() })
    .where(eq(mcpServers.id, target.parentId));
  logger.info("MCP categories set from the AI overview", {
    mcpServerId: target.parentId,
    mcpServerVersionId: target.versionId,
    from,
    to: slugs,
    categoriesSetBy: { from: server.categoriesSetBy, to: "ai" },
  });
  return true;
}

/** The engine's repository on the MCP tables; overview rows are read through it too. */
export const mcpOverviewRepository = createCatalogOverviewRepository<
  typeof mcpServerVersionAnalysis,
  McpAnalysisClassification
>({
  overviews: {
    table: mcpServerVersionOverviews,
    versionId: mcpServerVersionOverviews.mcpServerVersionId,
    fingerprint: mcpServerVersionOverviews.inputSha256,
  },
  analysis: {
    table: mcpServerVersionAnalysis,
    versionId: mcpServerVersionAnalysis.mcpServerVersionId,
  },
  versions: {
    table: mcpServerVersions,
    id: mcpServerVersions.id,
    parentId: mcpServerVersions.serverId,
  },
  promptVersion: MCP_OVERVIEW_PROMPT_VERSION,
  taxonomyVersion: MCP_OVERVIEW_TAXONOMY_VERSION,
  lockTarget: lockMcpServerVersion,
  applyCategories: applyMcpAnalysisCategories,
});

/** What publishing an MCP overview needs to know about its version. */
export type McpOverviewTarget = {
  versionId: string;
  serverId: string;
  fingerprint: string;
};

/** The MCP kind's storage as the overview engine sees it. */
export const mcpOverviewStore: OverviewStore<
  McpOverviewTarget,
  McpAnalysisClassification
> = {
  read: (versionId) => mcpOverviewRepository.read(versionId),
  request: (versionId, force) =>
    mcpOverviewRepository.request(versionId, force),
  claim: (versionId, requestId) =>
    mcpOverviewRepository.claim(versionId, requestId),
  fail: (versionId, requestId, error, retry) =>
    mcpOverviewRepository.fail(versionId, requestId, error, retry),
  findCached: (resultKey, versionId) =>
    mcpOverviewRepository.findCached(resultKey, versionId),
  publish: ({ subject, ...input }) =>
    mcpOverviewRepository.publish({
      ...input,
      versionId: subject.versionId,
      parentId: subject.serverId,
      fingerprint: subject.fingerprint,
    }),
  findInterrupted: () => mcpOverviewRepository.findInterrupted(),
};

// ---------------------------------------------------------------------------
// The version being described
// ---------------------------------------------------------------------------

/** A version as the overview reads it, with whether it may have one. */
export type McpOverviewSubjectRow = McpOverviewSourceRow & {
  versionId: string;
  serverId: string;
  identifier: string;
  version: string;
  // Published and public server, published version, and its latest one.
  eligible: boolean;
  // The README text, only when it is fetched (`ok`).
  readmeMd: string | null;
};

/** One version and its server; null when there is no such version. */
export async function findMcpOverviewSubjectRow(
  versionId: string,
): Promise<McpOverviewSubjectRow | null> {
  const result = await db.execute<McpOverviewSubjectRow>(sql`
    select
      v.id as "versionId",
      s.id as "serverId",
      s.identifier as "identifier",
      v.version as "version",
      (
        s.status = 'published' and s.visibility = 'public'
        and v.status = 'published'
        and v.id = ${latestPublishedVersionOf(sql`v.server_id`)}
      ) as "eligible",
      v.manifest_json as "manifestJson",
      v.provenance_json as "provenanceJson",
      v.readme_status as "readmeStatus",
      v.readme_sha256 as "readmeSha256",
      case when v.readme_status = 'ok' then v.readme_md end as "readmeMd"
    from ${mcpServerVersions} v
    join ${mcpServers} s on s.id = v.server_id
    where v.id = ${versionId}
  `);
  const row = result.rows[0];
  return row ? { ...row, eligible: row.eligible === true } : null;
}

// ---------------------------------------------------------------------------
// Which versions the scheduler queues
// ---------------------------------------------------------------------------

/** Eligible versions whose README is settled (not `pending`). */
const eligibleSettled = sql`
  s.status = 'published' and s.visibility = 'public'
  and v.status = 'published'
  and v.id = ${latestPublishedVersionOf(sql`v.server_id`)}
  and v.readme_status <> 'pending'
`;

const installedServers = sql`
  installed as (
    select distinct ${workspaceMcpInstalls.marketIdentifier} as identifier
    from ${workspaceMcpInstalls}
    where ${workspaceMcpInstalls.marketIdentifier} is not null
  )
`;

export type McpOverviewCandidateRow = {
  versionId: string;
  serverId: string;
  // Some workspace installed the server.
  installed: boolean;
  // It runs on the web (a remote transport).
  webExecutable: boolean;
};

/**
 * Eligible versions with a settled README that were never analysed (no
 * analysis row), most wanted first: servers some workspace installed, then
 * ones that run on the web, then the rest; newest in the catalog first within
 * each. `serverIds` narrows the search (tests stay within their own rows).
 */
export async function findNewMcpOverviewCandidates(input: {
  limit: number;
  serverIds?: readonly string[];
}): Promise<McpOverviewCandidateRow[]> {
  const result = await db.execute<McpOverviewCandidateRow>(sql`
    with ${installedServers}
    select
      v.id as "versionId",
      s.id as "serverId",
      (i.identifier is not null) as "installed",
      (s.transport is not null and s.transport <> 'stdio') as "webExecutable"
    from ${mcpServerVersions} v
    join ${mcpServers} s on s.id = v.server_id
    left join installed i on i.identifier = s.identifier
    where ${eligibleSettled}
      and not exists (
        select 1 from ${mcpServerVersionAnalysis} a
        where a.mcp_server_version_id = v.id
      )
      ${serverFilter(input.serverIds)}
    order by "installed" desc, "webExecutable" desc,
      s.published_at desc nulls last, s.id desc
    limit ${input.limit}
  `);
  return result.rows.map(candidateRow);
}

export type McpOverviewAttemptRow = McpOverviewCandidateRow &
  McpOverviewAttempt;

/**
 * Eligible versions with a settled README that were analysed before and have
 * no request in flight, by version id after `after`, at most `limit`: one
 * window of the scheduler's rotating check for stale overviews and failures
 * worth another try (`needsMcpOverviewRetry`). What the input fingerprint is
 * computed from comes along; README text does not.
 */
export async function findMcpOverviewAttempts(input: {
  after: string;
  limit: number;
  serverIds?: readonly string[];
}): Promise<McpOverviewAttemptRow[]> {
  const result = await db.execute<McpOverviewAttemptRow>(sql`
    with ${installedServers}
    select
      v.id as "versionId",
      s.id as "serverId",
      (i.identifier is not null) as "installed",
      (s.transport is not null and s.transport <> 'stdio') as "webExecutable",
      a.status as "status",
      a.error as "error",
      coalesce(v.readme_fetched_at > a.updated_at, false) as "readmeReadSince",
      v.manifest_json as "manifestJson",
      v.provenance_json as "provenanceJson",
      v.readme_status as "readmeStatus",
      v.readme_sha256 as "readmeSha256",
      (v.readme_md is not null) as "hasReadmeText",
      (
        select o.input_sha256 from ${mcpServerVersionOverviews} o
        where o.mcp_server_version_id = v.id
        order by o.locale
        limit 1
      ) as "overviewSha256"
    from ${mcpServerVersions} v
    join ${mcpServers} s on s.id = v.server_id
    join ${mcpServerVersionAnalysis} a on a.mcp_server_version_id = v.id
    left join installed i on i.identifier = s.identifier
    where ${eligibleSettled}
      and a.status not in ('pending', 'running')
      and v.id > ${input.after}
      ${serverFilter(input.serverIds)}
    order by v.id
    limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    ...row,
    ...candidateRow(row),
    readmeReadSince: row.readmeReadSince === true,
    hasReadmeText: row.hasReadmeText === true,
  }));
}

function serverFilter(serverIds: readonly string[] | undefined) {
  if (!serverIds) return sql``;
  if (serverIds.length === 0) return sql`and false`;
  return sql`and s.id in (${sql.join(
    serverIds.map((id) => sql`${id}`),
    sql`, `,
  )})`;
}

function candidateRow<T extends McpOverviewCandidateRow>(
  row: T,
): McpOverviewCandidateRow {
  return {
    versionId: row.versionId,
    serverId: row.serverId,
    installed: row.installed === true,
    webExecutable: row.webExecutable === true,
  };
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

/**
 * Each version's visible overview in `locale`, or in English when that one
 * is missing or hidden; versions with neither are absent from the map.
 */
export async function readMcpOverviews(input: {
  versionIds: readonly string[];
  locale: CatalogOverviewLocale;
}): Promise<Map<string, CatalogOverviewRead>> {
  return mcpOverviewRepository.readOverviews(input);
}

/** Actual visible translations, never the English fallback; one query per batch. */
export async function readMcpOverviewLocales(
  versionIds: readonly string[],
): Promise<Map<string, CatalogOverviewLocale[]>> {
  return mcpOverviewRepository.readOverviewLocales(versionIds);
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export type McpOverviewAdminRow = {
  locale: CatalogOverviewLocale;
  overview: CatalogOverviewJson;
  model: string;
  hidden: boolean;
  generatedAt: Date;
  inputSha256: string;
};

export type McpServerOverviewTarget = {
  serverId: string;
  identifier: string;
  categoriesSource: "auto" | "ai" | "admin";
  // The latest published version; null when the server has none.
  versionId: string | null;
  version: string | null;
};

/** A server by identifier (any status) and its latest published version. */
export async function findMcpServerOverviewTarget(
  identifier: string,
): Promise<McpServerOverviewTarget | null> {
  const result = await db.execute<McpServerOverviewTarget>(sql`
    select
      s.id as "serverId",
      s.identifier as "identifier",
      s.categories_set_by as "categoriesSource",
      l.id as "versionId",
      l.version as "version"
    from ${mcpServers} s
    left join ${mcpServerVersions} l
      on l.id = ${latestPublishedVersionOf(sql`s.id`)}
    where s.identifier = ${identifier}
    limit 1
  `);
  return result.rows[0] ?? null;
}

/** Every overview row of a version, hidden ones included, in locale order. */
export async function listMcpOverviewRows(
  versionId: string,
): Promise<McpOverviewAdminRow[]> {
  const rows = await db
    .select({
      locale: mcpServerVersionOverviews.locale,
      overview: mcpServerVersionOverviews.overview,
      model: mcpServerVersionOverviews.model,
      hidden: mcpServerVersionOverviews.hidden,
      generatedAt: mcpServerVersionOverviews.generatedAt,
      inputSha256: mcpServerVersionOverviews.inputSha256,
    })
    .from(mcpServerVersionOverviews)
    .where(eq(mcpServerVersionOverviews.mcpServerVersionId, versionId));
  const order = new Map(
    CATALOG_OVERVIEW_LOCALES.map((locale, index) => [locale, index]),
  );
  return rows
    .map((row) => ({
      ...row,
      overview: { ...row.overview, cautions: row.overview.cautions ?? null },
    }))
    .sort((a, b) => (order.get(a.locale) ?? 9) - (order.get(b.locale) ?? 9));
}

/** Hides or shows every locale of a version's overview; how many rows changed. */
export async function setMcpOverviewsHidden(input: {
  versionId: string;
  hidden: boolean;
}): Promise<number> {
  return mcpOverviewRepository.setOverviewsHidden(input);
}

export type McpOverviewCoverage = {
  // Latest published versions of published, public servers.
  eligible: number;
  readmePending: number;
  withOverview: number;
  hidden: number;
  inProgress: number;
  failed: number;
};

/** How far the catalog's overviews have got. */
export async function countMcpOverviewCoverage(): Promise<McpOverviewCoverage> {
  const hasOverview = sql`exists (
    select 1 from ${mcpServerVersionOverviews} o
    where o.mcp_server_version_id = v.id
  )`;
  const result = await db.execute<Record<keyof McpOverviewCoverage, number>>(
    sql`
      select
        count(*)::int as "eligible",
        count(*) filter (where v.readme_status = 'pending')::int
          as "readmePending",
        count(*) filter (where ${hasOverview})::int as "withOverview",
        count(*) filter (where exists (
          select 1 from ${mcpServerVersionOverviews} o
          where o.mcp_server_version_id = v.id and o.hidden
        ))::int as "hidden",
        count(*) filter (where a.status in ('pending', 'running'))::int
          as "inProgress",
        count(*) filter (where a.status = 'failed')::int as "failed"
      from ${mcpServers} s
      join ${mcpServerVersions} v on v.id = ${latestPublishedVersionOf(sql`s.id`)}
      left join ${mcpServerVersionAnalysis} a
        on a.mcp_server_version_id = v.id
      where s.status = 'published' and s.visibility = 'public'
    `,
  );
  const row = result.rows[0];
  return {
    eligible: Number(row?.eligible ?? 0),
    readmePending: Number(row?.readmePending ?? 0),
    withOverview: Number(row?.withOverview ?? 0),
    hidden: Number(row?.hidden ?? 0),
    inProgress: Number(row?.inProgress ?? 0),
    failed: Number(row?.failed ?? 0),
  };
}
