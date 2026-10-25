import { and, eq, inArray, sql } from "drizzle-orm";
import { db, marketMcpClaims, mcpServers } from "@sourceweft/db";
import type { ReviewRow } from "./review-sample";

/**
 * The domains whose DNS / well-known claim of a catalog server was verified,
 * by server identifier. Only the domain methods count: a GitHub claim proves
 * the listing, not a website (Issue #367 trust tier A).
 */
export async function findClaimedDomains(
  identifiers: string[],
): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  if (identifiers.length === 0) return found;
  const rows = await db
    .select({ identifier: mcpServers.identifier, target: marketMcpClaims.target })
    .from(marketMcpClaims)
    .innerJoin(mcpServers, eq(mcpServers.id, marketMcpClaims.serverId))
    .where(
      and(
        inArray(mcpServers.identifier, identifiers),
        eq(marketMcpClaims.status, "verified"),
        inArray(marketMcpClaims.method, ["dns_txt", "well_known"]),
      ),
    );
  for (const row of rows) {
    const list = found.get(row.identifier) ?? [];
    if (!list.includes(row.target)) list.push(row.target);
    found.set(row.identifier, list);
  }
  return found;
}

/**
 * The newest version of each server that carries a dry-run decision, for the
 * review sample (`scripts/icon-dry-run-report.ts`). "Newest" is deliberate:
 * the latest published version's decision is the one a display switch would
 * use, so an older version's stale decision is never sampled in its place.
 */
export async function findReviewRows(): Promise<ReviewRow[]> {
  const result = await db.execute(sql`
    select distinct on (s.identifier)
      s.identifier,
      v.version,
      v.provenance_json -> 'iconDecision' as decision,
      v.provenance_json -> 'iconCandidates' as candidates
    from mcp_server_versions v
    join mcp_servers s on s.id = v.server_id
    where v.provenance_json ? 'iconDecision'
    order by s.identifier, v.published_at desc nulls last, v.created_at desc
  `);
  return (result.rows as Array<Record<string, unknown>>).map(
    (row): ReviewRow => ({
      identifier: String(row.identifier),
      version: String(row.version),
      decision: row.decision as ReviewRow["decision"],
      candidates: (row.candidates as ReviewRow["candidates"]) ?? undefined,
    }),
  );
}
