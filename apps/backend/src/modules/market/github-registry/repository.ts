import { eq, inArray, sql } from "drizzle-orm";
import {
  MARKET_MCP_GITHUB_REGISTRY_PROVENANCE_KEY,
  type MarketMcpGithubRegistryProvenance,
} from "@sourceweft/market-contracts";
import { db, mcpServers, mcpServerVersions } from "@sourceweft/db";
import { latestPublishedVersionOf } from "../latest-version";
import type { GithubRegistryManifestPatch } from "./manifest";

/**
 * Database access for the GitHub MCP Registry enrichment. Only the latest
 * published version of a published, public, federated server is ever
 * annotated — the version the catalog shows (`latestPublishedVersionOf`),
 * from an upstream registry (`origin = 'upstream'`). Nothing here inserts a
 * row.
 */

export type GithubRegistryTarget = {
  serverId: string;
  versionId: string;
  identifier: string;
  name: string;
  summary: string;
  description: string | null;
  endpointUrl: string | null;
};

/** Every entry a GitHub row may annotate, with the fields the rules read. */
export async function listGithubRegistryTargets(): Promise<
  GithubRegistryTarget[]
> {
  const result = await db.execute<{
    serverId: string;
    versionId: string;
    identifier: string;
    name: string | null;
    summary: string | null;
    description: string | null;
    endpointUrl: string | null;
  }>(sql`
    select
      s.id as "serverId",
      v.id as "versionId",
      s.identifier as "identifier",
      v.manifest_json ->> 'name' as "name",
      v.manifest_json ->> 'summary' as "summary",
      v.manifest_json ->> 'description' as "description",
      v.manifest_json ->> 'endpointUrl' as "endpointUrl"
    from ${mcpServerVersions} v
    join ${mcpServers} s on s.id = v.server_id
    where v.status = 'published'
      and v.origin = 'upstream'
      and s.status = 'published'
      and s.visibility = 'public'
      and v.id = ${latestPublishedVersionOf(sql`v.server_id`)}
  `);
  return result.rows.map((row) => ({
    serverId: row.serverId,
    versionId: row.versionId,
    identifier: row.identifier,
    name: row.name ?? "",
    summary: row.summary ?? "",
    description: row.description,
    endpointUrl: row.endpointUrl,
  }));
}

/**
 * Store a match: the record under `provenanceJson.githubRegistry` (replacing
 * the previous one, the rest of the provenance untouched) and, when the rules
 * changed anything, the same fields on the version's manifest and on the
 * server row the catalog lists from. Only a manifest change moves the
 * server's `updated_at`: a re-run that only refreshes `fetchedAt` is not an
 * update the page should show.
 */
export async function writeGithubRegistryMatch(input: {
  serverId: string;
  versionId: string;
  record: MarketMcpGithubRegistryProvenance;
  patch: GithubRegistryManifestPatch;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const patched = Object.keys(input.patch).length > 0;
  const record = JSON.stringify(input.record);
  await db.transaction(async (tx) => {
    await tx
      .update(mcpServerVersions)
      .set({
        provenanceJson: sql`${mcpServerVersions.provenanceJson} || jsonb_build_object(${MARKET_MCP_GITHUB_REGISTRY_PROVENANCE_KEY}::text, ${record}::jsonb)`,
        ...(patched
          ? {
              manifestJson: sql`${mcpServerVersions.manifestJson} || ${JSON.stringify(input.patch)}::jsonb`,
            }
          : {}),
      })
      .where(eq(mcpServerVersions.id, input.versionId));
    if (patched) {
      await tx
        .update(mcpServers)
        .set({
          ...(input.patch.name !== undefined ? { name: input.patch.name } : {}),
          ...(input.patch.summary !== undefined
            ? { summary: input.patch.summary }
            : {}),
          ...(input.patch.description !== undefined
            ? { description: input.patch.description }
            : {}),
          updatedAt: now,
        })
        .where(eq(mcpServers.id, input.serverId));
    }
  });
}

/**
 * The records an earlier pass stored for these versions
 * (`provenanceJson.githubRegistry`), by version id, for a federation sync to
 * carry over; versions without one are absent.
 */
export async function findStoredGithubRegistryRecords(
  versionIds: string[],
): Promise<Map<string, unknown>> {
  if (versionIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      id: mcpServerVersions.id,
      record: sql<unknown>`${mcpServerVersions.provenanceJson} -> ${MARKET_MCP_GITHUB_REGISTRY_PROVENANCE_KEY}::text`,
    })
    .from(mcpServerVersions)
    .where(inArray(mcpServerVersions.id, versionIds));
  return new Map(
    rows.flatMap((row) =>
      row.record == null ? [] : [[row.id, row.record] as const],
    ),
  );
}
