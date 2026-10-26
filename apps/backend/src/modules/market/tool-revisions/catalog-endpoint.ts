import { and, desc, eq } from "drizzle-orm";
import { db, mcpServerVersions, mcpServers } from "@sourceweft/db";
import { publicMarketMcpCondition } from "../read-repository";

/**
 * The listing a pinned tool list would attach to: a published, public entry
 * and the raw `manifest.endpointUrl` of its latest published version (the
 * version the catalog shows, ordered as `latest-version.ts` orders it). Not
 * the homepage, the publisher's domain, an older version, nor anything an
 * owner edited.
 */
export type CatalogEndpoint = {
  itemId: string;
  identifier: string;
  /** Null when the latest version has no remote endpoint. */
  endpointUrl: string | null;
};

export async function readCatalogEndpoint(
  identifier: string,
): Promise<CatalogEndpoint | null> {
  const [server] = await db
    .select({ id: mcpServers.id, identifier: mcpServers.identifier })
    .from(mcpServers)
    .where(and(eq(mcpServers.identifier, identifier), publicMarketMcpCondition()))
    .limit(1);
  if (!server) return null;
  const [version] = await db
    .select({ manifestJson: mcpServerVersions.manifestJson })
    .from(mcpServerVersions)
    .where(
      and(
        eq(mcpServerVersions.serverId, server.id),
        eq(mcpServerVersions.status, "published"),
      ),
    )
    .orderBy(desc(mcpServerVersions.publishedAt), desc(mcpServerVersions.createdAt))
    .limit(1);
  const endpoint = version?.manifestJson?.endpointUrl;
  return {
    itemId: server.id,
    identifier: server.identifier,
    endpointUrl: typeof endpoint === "string" ? endpoint : null,
  };
}
