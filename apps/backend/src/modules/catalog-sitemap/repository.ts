import { sql } from "drizzle-orm";
import {
  db,
  mcpServers,
  mcpServerVersions,
  skillDefinitions,
  skillVersions,
} from "@sourceweft/db";
import {
  catalogSitemapPrefixSchema,
  SITEMAP_MAX_URLS,
  type CatalogSitemapKind,
  type CatalogSitemapIndex,
  type CatalogSitemapShard,
} from "@sourceweft/market-contracts";
import { publicMarketMcpCondition } from "../market/read-repository";
import { publicMarketSkillCondition } from "../skills/market/read-repository";
import { readMcpOverviewLocales } from "../market/overview/repository";
import { readSkillOverviewLocales } from "../skills/market/overview-repository";
import { planSitemapShards } from "./planner";

function source(kind: CatalogSitemapKind) {
  if (kind === "mcp")
    return {
      from: sql`${mcpServers}`,
      where: publicMarketMcpCondition(),
      id: sql`${mcpServers.id}`,
      key: sql`${mcpServers.identifier}`,
      modified: sql`${mcpServers.updatedAt}`,
      version: sql`(select ${mcpServerVersions.id} from ${mcpServerVersions}
      where ${mcpServerVersions.serverId} = ${mcpServers.id} and ${mcpServerVersions.status} = 'published'
      order by ${mcpServerVersions.publishedAt} desc, ${mcpServerVersions.createdAt} desc limit 1)`,
    };
  return {
    from: sql`${skillDefinitions} inner join ${skillVersions} on ${skillVersions.skillId} = ${skillDefinitions.id}`,
    where: publicMarketSkillCondition(),
    id: sql`${skillDefinitions.id}`,
    key: sql`${skillDefinitions.slug}`,
    modified: sql`coalesce(${skillVersions.publishedAt}, ${skillDefinitions.listedAt}, ${skillDefinitions.createdAt})`,
    version: sql`${skillVersions.id}`,
  };
}

export async function readCatalogSitemapIndex(): Promise<CatalogSitemapIndex> {
  const groups = await Promise.all(
    (["mcp", "skills"] as const).map(async (kind) => {
      const s = source(kind);
      const shards = await planSitemapShards(async (prefix) => {
        const rows = await db.execute<{ prefix: string; count: number }>(sql`
        select left(md5(${s.id}), ${prefix.length + 1}) as prefix, count(*)::integer as count
        from ${s.from} where ${s.where} and md5(${s.id}) like ${prefix + "%"}
        group by 1 order by 1`);
        return rows.rows;
      });
      return shards.map((shard) => ({ kind, ...shard }));
    }),
  );
  const shards = groups.flat();
  if (shards.length > SITEMAP_MAX_URLS)
    throw new Error("Sitemap index exceeds protocol limit");
  return { shards };
}

export async function readCatalogSitemapShard(
  kind: CatalogSitemapKind,
  prefix: string,
): Promise<CatalogSitemapShard> {
  catalogSitemapPrefixSchema.parse(prefix);
  const s = source(kind);
  // Older index links remain readable after a bucket splits. Never truncate a
  // shard; the extra row detects the protocol ceiling before returning data.
  const result = await db.execute<{
    key: string;
    modified: Date | string | null;
    versionId: string | null;
  }>(sql`
    select ${s.key} as key, ${s.modified} as modified, ${s.version} as "versionId"
    from ${s.from} where ${s.where} and md5(${s.id}) like ${prefix + "%"}
    order by ${s.id} limit ${SITEMAP_MAX_URLS + 1}`);
  if (result.rows.length > SITEMAP_MAX_URLS)
    throw new Error("Sitemap shard exceeds protocol limit; refresh the index");
  const versionIds = result.rows.flatMap((r) =>
    r.versionId ? [r.versionId] : [],
  );
  const locales =
    kind === "mcp"
      ? await readMcpOverviewLocales(versionIds)
      : await readSkillOverviewLocales(versionIds);
  return {
    items: result.rows.map((r) => ({
      key: r.key,
      updatedAt: r.modified ? new Date(r.modified).toISOString() : null,
      overviewLocales: r.versionId ? (locales.get(r.versionId) ?? []) : [],
    })),
  };
}
