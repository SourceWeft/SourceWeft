import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { McpReadmeStatus } from "@sourceweft/market-contracts";
import {
  db,
  mcpServers,
  mcpServerVersions,
  workspaceMcpInstalls,
} from "@sourceweft/db";
import { latestPublishedVersionOf } from "../latest-version";
import type { McpReadmeColumns } from "./readme-state";

/**
 * Database access for MCP server READMEs. Only the latest published version
 * of a published, public server is ever fetched — the version the catalog
 * shows (`latestPublishedVersionOf`) — so every query here scopes to it.
 */

export type DueMcpReadme = {
  versionId: string;
  identifier: string;
  installed: boolean;
  webExecutable: boolean;
};

/**
 * Versions whose README is due, most wanted first: servers some workspace has
 * installed, then ones that run on the web (a remote transport), then the
 * rest; newest in the catalog first within each.
 */
export async function findDueMcpReadmes(input: {
  limit: number;
  now?: Date;
}): Promise<DueMcpReadme[]> {
  const now = input.now ?? new Date();
  const result = await db.execute<{
    versionId: string;
    identifier: string;
    installed: boolean;
    webExecutable: boolean;
  }>(sql`
    with installed as (
      select distinct ${workspaceMcpInstalls.marketIdentifier} as identifier
      from ${workspaceMcpInstalls}
      where ${workspaceMcpInstalls.marketIdentifier} is not null
    )
    select
      v.id as "versionId",
      s.identifier as "identifier",
      (i.identifier is not null) as "installed",
      (s.transport is not null and s.transport <> 'stdio') as "webExecutable"
    from ${mcpServerVersions} v
    join ${mcpServers} s on s.id = v.server_id
    left join installed i on i.identifier = s.identifier
    where v.readme_next_fetch_at <= ${now}
      and v.status = 'published'
      and s.status = 'published'
      and s.visibility = 'public'
      and v.id = ${latestPublishedVersionOf(sql`v.server_id`)}
    order by "installed" desc, "webExecutable" desc,
      s.published_at desc nulls last, s.id desc
    limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    versionId: row.versionId,
    identifier: row.identifier,
    installed: row.installed === true,
    webExecutable: row.webExecutable === true,
  }));
}

export type ClaimedMcpReadme = {
  versionId: string;
  identifier: string;
  repoUrl: string | null;
  provenanceJson: Record<string, unknown> | null;
  readmeStatus: McpReadmeStatus;
  readmeAttempts: number;
  readmeEtag: string | null;
  readmePath: string | null;
};

/**
 * Take one due version for fetching: push its next fetch out to `leaseUntil`
 * so another batch (or a redelivered one) passes it over, and read what the
 * fetch needs. Null when it is no longer due or no longer fetched at all (not
 * published and public). A worker that dies mid-fetch leaves the lease to
 * expire, after which the version is due again.
 */
export async function claimMcpReadme(input: {
  versionId: string;
  leaseUntil: Date;
  now?: Date;
}): Promise<ClaimedMcpReadme | null> {
  const now = input.now ?? new Date();
  const result = await db.execute<ClaimedMcpReadme>(sql`
    update ${mcpServerVersions} v
    set readme_next_fetch_at = ${input.leaseUntil}
    from ${mcpServers} s
    where v.id = ${input.versionId}
      and s.id = v.server_id
      and v.readme_next_fetch_at <= ${now}
      and v.status = 'published'
      and s.status = 'published'
      and s.visibility = 'public'
    returning
      v.id as "versionId",
      s.identifier as "identifier",
      s.repo_url as "repoUrl",
      v.provenance_json as "provenanceJson",
      v.readme_status as "readmeStatus",
      v.readme_attempts as "readmeAttempts",
      v.readme_etag as "readmeEtag",
      v.readme_path as "readmePath"
  `);
  return result.rows[0] ?? null;
}

/** Write the README columns a transition or a submission produced. */
export async function writeMcpReadmeColumns(
  versionId: string,
  columns: McpReadmeColumns,
): Promise<void> {
  await db
    .update(mcpServerVersions)
    .set(columns)
    .where(eq(mcpServerVersions.id, versionId));
}

/**
 * Push still-due versions back to `until` (GitHub's rate-limit reset), so
 * the rest of a batch that could not be fetched is not queued again before
 * requests are accepted.
 */
export async function deferMcpReadmes(input: {
  versionIds: string[];
  until: Date;
  now?: Date;
}): Promise<number> {
  if (input.versionIds.length === 0) {
    return 0;
  }
  const rows = await db
    .update(mcpServerVersions)
    .set({ readmeNextFetchAt: input.until })
    .where(
      and(
        inArray(mcpServerVersions.id, input.versionIds),
        lte(mcpServerVersions.readmeNextFetchAt, input.now ?? new Date()),
      ),
    )
    .returning({ id: mcpServerVersions.id });
  return rows.length;
}

/**
 * A market admin's "fetch this README again": the latest version of a
 * published, public server goes back to `pending`, due now, with no attempts
 * and no ETag (so the next fetch reads the file in full rather than accept a
 * 304). Null when there is no such server.
 */
export async function resetMcpReadme(input: {
  identifier: string;
  now?: Date;
}): Promise<{ versionId: string; version: string } | null> {
  const now = input.now ?? new Date();
  const result = await db.execute<{ versionId: string; version: string }>(sql`
    update ${mcpServerVersions} v
    set readme_status = 'pending',
      readme_next_fetch_at = ${now},
      readme_attempts = 0,
      readme_error = null,
      readme_etag = null
    from ${mcpServers} s
    where s.identifier = ${input.identifier}
      and s.status = 'published'
      and s.visibility = 'public'
      and v.server_id = s.id
      and v.id = ${latestPublishedVersionOf(sql`s.id`)}
    returning v.id as "versionId", v.version as "version"
  `);
  return result.rows[0] ?? null;
}

/** The README columns the detail API shows, for one version. */
export async function readMcpReadme(versionId: string) {
  const [row] = await db
    .select({
      readmeStatus: mcpServerVersions.readmeStatus,
      readmeMd: mcpServerVersions.readmeMd,
      readmePath: mcpServerVersions.readmePath,
      readmeRef: mcpServerVersions.readmeRef,
    })
    .from(mcpServerVersions)
    .where(eq(mcpServerVersions.id, versionId))
    .limit(1);
  return row ?? null;
}

export type McpReadmeStatusCounts = {
  /** Latest versions of published, public servers, by README status. */
  byStatus: Record<McpReadmeStatus, number>;
  /** Of those, due for a fetch now. */
  due: number;
  /** Of those, no longer fetched until an admin asks again. */
  stopped: number;
};

/** README coverage of the catalog the fetch job serves. */
export async function countMcpReadmes(
  now: Date = new Date(),
): Promise<McpReadmeStatusCounts> {
  const result = await db.execute<{
    status: McpReadmeStatus;
    total: number;
    due: number;
    stopped: number;
  }>(sql`
    select
      v.readme_status as "status",
      count(*)::int as "total",
      count(*) filter (where v.readme_next_fetch_at <= ${now})::int as "due",
      count(*) filter (where v.readme_next_fetch_at is null)::int as "stopped"
    from ${mcpServers} s
    join ${mcpServerVersions} v
      on v.id = ${latestPublishedVersionOf(sql`s.id`)}
    where s.status = 'published' and s.visibility = 'public'
    group by v.readme_status
  `);
  const byStatus: Record<McpReadmeStatus, number> = {
    pending: 0,
    ok: 0,
    not_found: 0,
    too_large: 0,
    unsupported_host: 0,
    error: 0,
  };
  let due = 0;
  let stopped = 0;
  for (const row of result.rows) {
    byStatus[row.status] = Number(row.total);
    due += Number(row.due);
    stopped += Number(row.stopped);
  }
  return { byStatus, due, stopped };
}
