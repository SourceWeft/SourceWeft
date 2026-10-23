import { sql } from "drizzle-orm";
import {
  db,
  mcpServers,
  mcpServerVersionOverviews,
  skillDefinitions,
  skillVersionOverviews,
  skillVersions,
} from "@sourceweft/db";
import {
  catalogSitemapPrefixSchema,
  SITEMAP_MAX_URLS,
  type CatalogSitemapKind,
  type CatalogSitemapIndex,
  type CatalogSitemapShard,
} from "@sourceweft/market-contracts";
import { latestPublishedVersionOf } from "../market/latest-version";
import {
  mcpReadmeSharedOf,
  publicMarketMcpCondition,
} from "../market/read-repository";
import {
  primarySkillSlugOf,
  publicMarketSkillCondition,
} from "../skills/market/read-repository";
import { readMcpOverviewLocales } from "../market/overview/repository";
import { readSkillOverviewLocales } from "../skills/market/overview-repository";
import { planSitemapShards } from "./planner";

/**
 * What a sitemap lists for each kind. `from`/`where` alone are the rows (the
 * index only counts them); `shardFrom` adds what a shard row needs to name
 * the version the page shows. `modified` is the lastmod: the later of the
 * listing's own last change and the newest overview of the shown version —
 * hidden ones included, so hiding an overview never moves lastmod back. A
 * README or manifest change reaches it through the overview it regenerates;
 * columns every sync or README recheck restamps (`last_indexed_at`,
 * `readme_fetched_at`) are deliberately not part of it.
 *
 * `where` leaves out the pages that stay out of search, through the same
 * predicates the detail API reports them with: a server whose README is one
 * file many servers show (`noindex`), and a skill whose files another public
 * skill's page carries (canonical to that page).
 */
function source(kind: CatalogSitemapKind) {
  if (kind === "mcp")
    return {
      from: sql`${mcpServers}`,
      shardFrom: sql`${mcpServers} left join lateral (
        select ${latestPublishedVersionOf(mcpServers.id)} as id
      ) shown on true`,
      where: sql`${publicMarketMcpCondition()} and not ${mcpReadmeSharedOf(
        latestPublishedVersionOf(mcpServers.id),
      )}`,
      id: sql`${mcpServers.id}`,
      key: sql`${mcpServers.identifier}`,
      modified: sql`greatest(${mcpServers.updatedAt}, (
        select max(${mcpServerVersionOverviews.generatedAt}) from ${mcpServerVersionOverviews}
        where ${mcpServerVersionOverviews.mcpServerVersionId} = shown.id))`,
      version: sql`shown.id`,
    };
  const from = sql`${skillDefinitions} inner join ${skillVersions} on ${skillVersions.skillId} = ${skillDefinitions.id}`;
  return {
    from,
    shardFrom: from,
    where: sql`${publicMarketSkillCondition()} and ${primarySkillSlugOf(
      skillVersions.contentHash,
    )} = ${skillDefinitions.slug}`,
    id: sql`${skillDefinitions.id}`,
    key: sql`${skillDefinitions.slug}`,
    modified: sql`greatest(coalesce(${skillVersions.publishedAt}, ${skillDefinitions.listedAt}, ${skillDefinitions.createdAt}), (
      select max(${skillVersionOverviews.generatedAt}) from ${skillVersionOverviews}
      where ${skillVersionOverviews.skillVersionId} = ${skillVersions.id}))`,
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
    from ${s.shardFrom} where ${s.where} and md5(${s.id}) like ${prefix + "%"}
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
