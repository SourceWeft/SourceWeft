import { sql } from "drizzle-orm";
import type {
  MarketMcpToolManifest,
  MarketMcpValidation,
} from "@sourceweft/market-contracts";
import { db, mcpServers, mcpServerVersions } from "@sourceweft/db";
import { latestPublishedVersionOf } from "../latest-version";
import {
  MCP_STDIO_REVALIDATE_MS,
  type McpStdioSelfDescription,
} from "./stdio-state";

/**
 * Database access for the stdio validation (Issue #367, W1b). Everything it
 * stores lives in the version's `provenance_json` (`stdioValidation` for the
 * claim, `selfDescription` + `validatedAt` or `validation` for the outcome)
 * and `manifest_json.tools`; the federation upsert carries those keys across
 * a re-sync (`ingest/repository.ts`). Only the latest published version of a
 * published, public server that lists packages is ever validated.
 */

/**
 * How long a claimed version is held back from other batches. Well above one
 * validation's worst case (sandbox create, install, start, teardown); a
 * worker that dies mid-batch only delays its versions by this much.
 */
export const MCP_STDIO_CLAIM_LEASE_MS = 30 * 60 * 1000;

const PACKAGES = sql`v.provenance_json #> '{registryServer,packages}'`;
const ATTEMPTED_AT = sql`v.provenance_json #>> '{stdioValidation,attemptedAt}'`;

/**
 * A version is due when it lists packages, its last claim is older than the
 * lease, and it was neither validated nor found failing within
 * {@link MCP_STDIO_REVALIDATE_MS}. The timestamps are ones this module (or
 * W1's probe, for `validatedAt`) wrote, so the casts are safe.
 */
function dueCondition(now: Date) {
  const leaseFloor = new Date(now.getTime() - MCP_STDIO_CLAIM_LEASE_MS);
  const staleFloor = new Date(now.getTime() - MCP_STDIO_REVALIDATE_MS);
  return sql`
    v.status = 'published'
    and s.status = 'published'
    and s.visibility = 'public'
    and v.id = ${latestPublishedVersionOf(sql`v.server_id`)}
    and jsonb_typeof(${PACKAGES}) = 'array'
    and jsonb_array_length(${PACKAGES}) > 0
    and coalesce((${ATTEMPTED_AT})::timestamptz, '-infinity'::timestamptz) <= ${leaseFloor}
    and coalesce((v.provenance_json ->> 'validatedAt')::timestamptz, '-infinity'::timestamptz) <= ${staleFloor}
    and coalesce((v.provenance_json #>> '{validation,at}')::timestamptz, '-infinity'::timestamptz) <= ${staleFloor}
  `;
}

export type DueMcpStdioValidation = {
  versionId: string;
  identifier: string;
  neverTried: boolean;
};

/** Versions due for a start, never-tried ones first, then the newest. */
export async function findDueMcpStdioValidations(input: {
  limit: number;
  now?: Date;
}): Promise<DueMcpStdioValidation[]> {
  const now = input.now ?? new Date();
  const result = await db.execute<{
    versionId: string;
    identifier: string;
    neverTried: boolean;
  }>(sql`
    select
      v.id as "versionId",
      s.identifier as "identifier",
      ((${ATTEMPTED_AT}) is null) as "neverTried"
    from ${mcpServerVersions} v
    join ${mcpServers} s on s.id = v.server_id
    where ${dueCondition(now)}
    order by "neverTried" desc, v.created_at desc, v.id desc
    limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    versionId: row.versionId,
    identifier: row.identifier,
    neverTried: row.neverTried === true,
  }));
}

export type ClaimedMcpStdioValidation = {
  versionId: string;
  serverId: string;
  identifier: string;
  version: string;
  provenanceJson: Record<string, unknown>;
};

/**
 * Take the due versions among `versionIds` in one statement: stamp their
 * claim (`stdioValidation.attemptedAt`) so another batch passes them over
 * until the lease lapses, count the attempt (`stdioValidation.attempts`,
 * which an outcome clears, so it counts the tries since the last outcome),
 * and read what the start needs. A version no longer due is left out. The
 * rows come back in no particular order.
 */
export async function claimMcpStdioValidations(input: {
  versionIds: string[];
  now?: Date;
}): Promise<ClaimedMcpStdioValidation[]> {
  if (input.versionIds.length === 0) {
    return [];
  }
  const now = input.now ?? new Date();
  const result = await db.execute<ClaimedMcpStdioValidation>(sql`
    update ${mcpServerVersions} v
    set provenance_json = v.provenance_json || jsonb_build_object(
      'stdioValidation', jsonb_build_object(
        'attemptedAt', ${now.toISOString()}::text,
        'attempts', coalesce((v.provenance_json #>> '{stdioValidation,attempts}')::int, 0) + 1
      )
    )
    from ${mcpServers} s
    where v.id = any(${sql.param(input.versionIds)}::text[])
      and s.id = v.server_id
      and ${dueCondition(now)}
    returning
      v.id as "versionId",
      s.id as "serverId",
      s.identifier as "identifier",
      v.version as "version",
      v.provenance_json as "provenanceJson"
  `);
  return result.rows;
}

/**
 * A start that answered: the self-description and `validatedAt` go to the
 * provenance (a previous `validation` goes), the tools to the manifest, and
 * the server's `toolsCount` follows while this is its latest version.
 */
export async function writeMcpStdioValidationSuccess(input: {
  versionId: string;
  serverId: string;
  selfDescription: McpStdioSelfDescription;
  validatedAt: string;
  tools: MarketMcpToolManifest[];
}): Promise<void> {
  const patch = JSON.stringify({
    selfDescription: input.selfDescription,
    validatedAt: input.validatedAt,
  });
  await db.execute(sql`
    update ${mcpServerVersions}
    set provenance_json = ((provenance_json - 'validation') #- '{stdioValidation,attempts}') || ${patch}::jsonb,
      manifest_json = jsonb_set(manifest_json, '{tools}', ${JSON.stringify(input.tools)}::jsonb, true)
    where id = ${input.versionId}
  `);
  await db.execute(sql`
    update ${mcpServers} s
    set metadata_json = jsonb_set(s.metadata_json, '{toolsCount}', to_jsonb(${input.tools.length}::int), true)
    where s.id = ${input.serverId}
      and ${latestPublishedVersionOf(sql`s.id`)} = ${input.versionId}
  `);
}

/** A start that did not answer, or a package the sandbox cannot run. */
export async function writeMcpStdioValidationFailure(input: {
  versionId: string;
  validation: MarketMcpValidation;
}): Promise<void> {
  await db.execute(sql`
    update ${mcpServerVersions}
    set provenance_json = (provenance_json #- '{stdioValidation,attempts}') || jsonb_build_object(
      'validation', ${JSON.stringify(input.validation)}::jsonb
    )
    where id = ${input.versionId}
  `);
}

export type McpStdioValidationCounts = {
  /** Latest versions of published, public servers that list packages. */
  withPackages: number;
  validated: number;
  failed: number;
  unsupported: number;
  /** Of those with packages, due for a start now. */
  due: number;
};

/** Coverage of the catalog's stdio packages, for operators. */
export async function countMcpStdioValidations(
  now: Date = new Date(),
): Promise<McpStdioValidationCounts> {
  const result = await db.execute<
    Record<keyof McpStdioValidationCounts, number>
  >(sql`
    select
      count(*)::int as "withPackages",
      count(*) filter (where v.provenance_json ? 'validatedAt')::int as "validated",
      count(*) filter (where v.provenance_json #>> '{validation,status}' = 'failed')::int as "failed",
      count(*) filter (where v.provenance_json #>> '{validation,status}' = 'unsupported')::int as "unsupported",
      count(*) filter (where ${dueCondition(now)})::int as "due"
    from ${mcpServerVersions} v
    join ${mcpServers} s on s.id = v.server_id
    where v.status = 'published'
      and s.status = 'published'
      and s.visibility = 'public'
      and v.id = ${latestPublishedVersionOf(sql`v.server_id`)}
      and jsonb_typeof(${PACKAGES}) = 'array'
      and jsonb_array_length(${PACKAGES}) > 0
  `);
  const row = result.rows[0];
  return {
    withPackages: Number(row?.withPackages ?? 0),
    validated: Number(row?.validated ?? 0),
    failed: Number(row?.failed ?? 0),
    unsupported: Number(row?.unsupported ?? 0),
    due: Number(row?.due ?? 0),
  };
}
