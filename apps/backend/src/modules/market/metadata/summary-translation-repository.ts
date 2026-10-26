import { eq, sql } from "drizzle-orm";
import {
  db,
  mcpServers,
  mcpServerVersionOverviews,
  mcpServerVersions,
  workspaceMcpInstalls,
} from "@sourceweft/db";
import { latestPublishedVersionOf } from "../latest-version";
import {
  MCP_SUMMARY_TRANSLATION_KEY,
  MCP_SUMMARY_TRANSLATION_MAX_ATTEMPTS,
  MCP_SUMMARY_TRANSLATION_MIN_SOURCE_CHARS,
  MCP_SUMMARY_TRANSLATION_RETRY_MS,
  MCP_SUMMARY_TRANSLATION_VERSION,
  type McpSummaryTranslation,
} from "./summary-translation";

/**
 * Database access for the summary translation pass: which versions need a
 * translation, and storing the record. Nothing here inserts a row; the record
 * lives on the version's provenance next to the other derived records.
 */

export type SummaryTranslationCandidate = {
  versionId: string;
  identifier: string;
  /** The stored summary, exactly as the record's hash is taken. */
  summary: string;
  /** The version's own record: absent, stale, or an old failure. */
  record: unknown;
  /** The newest record of any other version of the same server, if any. */
  previous: unknown;
};

/**
 * Latest versions of published, public servers whose README is settled, that
 * have no visible AI overview (an overview already speaks the visitor's
 * language) and a summary worth translating, whose record is missing, made
 * for other text or another prompt version, or a failure old enough to try
 * again (the delay doubles with each failure, and a text that failed three
 * times is left alone until the English changes). Servers some workspace installed first, then the newest versions.
 * The summary is compared by the same sha256 the record stores, so a stale
 * record is found in SQL.
 */
export async function findSummaryTranslationCandidates(input: {
  limit: number;
  now?: Date;
}): Promise<SummaryTranslationCandidate[]> {
  const now = input.now ?? new Date();
  const retryBaseSeconds = MCP_SUMMARY_TRANSLATION_RETRY_MS / 1000;
  const key = MCP_SUMMARY_TRANSLATION_KEY;
  const result = await db.execute<SummaryTranslationCandidate>(sql`
    with installed as (
      select distinct ${workspaceMcpInstalls.marketIdentifier} as identifier
      from ${workspaceMcpInstalls}
      where ${workspaceMcpInstalls.marketIdentifier} is not null
    )
    select
      v.id as "versionId",
      s.identifier as "identifier",
      s.summary as "summary",
      v.provenance_json -> ${key}::text as "record",
      (
        select p.provenance_json -> ${key}::text
        from ${mcpServerVersions} p
        where p.server_id = v.server_id and p.id <> v.id
          and p.provenance_json ? ${key}::text
        order by p.created_at desc
        limit 1
      ) as "previous"
    from ${mcpServerVersions} v
    join ${mcpServers} s on s.id = v.server_id
    left join installed i on i.identifier = s.identifier
    where s.status = 'published' and s.visibility = 'public'
      and v.status = 'published'
      and v.id = ${latestPublishedVersionOf(sql`v.server_id`)}
      and v.readme_status <> 'pending'
      and not exists (
        select 1 from ${mcpServerVersionOverviews} o
        where o.mcp_server_version_id = v.id and o.hidden = false
      )
      and char_length(btrim(s.summary)) >= ${MCP_SUMMARY_TRANSLATION_MIN_SOURCE_CHARS}
      and s.summary !~ '^MCP server \\S+ from the MCP registry\\.?$'
      and (
        not (v.provenance_json ? ${key}::text)
        or v.provenance_json -> ${key}::text ->> 'sourceHash'
          is distinct from encode(sha256(convert_to(s.summary, 'UTF8')), 'hex')
        or v.provenance_json -> ${key}::text ->> 'version'
          is distinct from ${String(MCP_SUMMARY_TRANSLATION_VERSION)}
        or (
          v.provenance_json -> ${key}::text ->> 'status' = 'failed'
          and coalesce((v.provenance_json -> ${key}::text ->> 'attempts')::int, 1)
            < ${MCP_SUMMARY_TRANSLATION_MAX_ATTEMPTS}
          and (v.provenance_json -> ${key}::text ->> 'attemptedAt')::timestamptz
            + (${retryBaseSeconds} * power(2, coalesce((v.provenance_json -> ${key}::text ->> 'attempts')::int, 1) - 1))
              * interval '1 second'
            <= ${now}::timestamptz
        )
      )
    order by (i.identifier is not null) desc, v.created_at desc, v.id desc
    limit ${input.limit}
  `);
  return result.rows;
}

/** Store a version's record (replacing the previous one, the rest untouched). */
export async function writeSummaryTranslation(
  versionId: string,
  record: McpSummaryTranslation,
): Promise<void> {
  await db
    .update(mcpServerVersions)
    .set({
      provenanceJson: sql`${mcpServerVersions.provenanceJson} || jsonb_build_object(${MCP_SUMMARY_TRANSLATION_KEY}::text, ${JSON.stringify(record)}::jsonb)`,
    })
    .where(eq(mcpServerVersions.id, versionId));
}
