import { sql } from "drizzle-orm";
import { mcpServerVersions } from "@sourceweft/db";

/**
 * The version the catalog shows for server `serverId` (a value or a column
 * reference): its newest published one, ordered exactly as
 * `read-repository.ts` picks "latest" — `published_at` then `created_at`,
 * both descending (nulls first, as PostgreSQL sorts them). The README fetch
 * and the AI overview work on this version only.
 */
export const latestPublishedVersionOf = (serverId: unknown) => sql`(
  select l.id from ${mcpServerVersions} l
  where l.server_id = ${serverId} and l.status = 'published'
  order by l.published_at desc, l.created_at desc
  limit 1
)`;
