import {
  marketMcpIconSourceSchema,
  marketMcpToolsValidationSchema,
  mcpTransportSchema,
  type MarketItemSummary,
  type ListMarketMcpToolRevisionsRequest,
  type ListMarketMcpToolRevisionsResponse,
  type MarketItemVersion,
  type MarketMcpAiOverview,
  type MarketMcpIconSource,
  type MarketMcpLocale,
  type MarketMcpProductGroup,
  type MarketMcpReadme,
  type MarketMcpScore,
  type MarketMcpToolsRevision,
  type MarketMcpToolsValidation,
  type McpRuntime,
  type McpTransport,
} from "@sourceweft/market-contracts";
import { and, desc, eq, exists, ilike, inArray, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import {
  db,
  mcpCategories,
  mcpServerCategories,
  mcpServers,
  mcpServerVersions,
} from "@sourceweft/db";
import { githubAvatarUrl, githubOwner } from "./icons/chain";
import {
  readMcpOverviewLocales,
  readMcpOverviews,
} from "./overview/repository";
import {
  applyOwnerOverridesToItem,
  applyOwnerOverridesToManifest,
  ownerSubmittedTools,
} from "./claims/overrides";
import {
  normaliseLanguage,
  normaliseLicense,
  resolveListingMetadata,
} from "./metadata/listing-metadata";
import {
  MCP_SUMMARY_TRANSLATION_KEY,
  descriptionLanguageFor,
  localizedSummaryFor,
} from "./metadata/summary-translation";
import { findOwnerLayersByServerIds } from "./claims/repository";
import {
  applyReferenceToolsToManifest,
  baseToolsOf,
  readReferenceTools,
  readToolRevisionsPage,
  readToolsRevision,
} from "./tool-revisions";
import {
  findBrandPublisherDomains,
  findProductGroupMembers,
  productGroupEntryOf,
} from "./grouping/query";
import { isOfficialEntry } from "./grouping/product-group";
import { publisherMeta } from "./publisher";
import { latestPublishedVersionOf } from "./latest-version";
import { readMcpReadme } from "./readme/readme-repository";
import { mcpReadmeView } from "./readme/readme-state";
import { scoreMcp } from "./score/score";

type MarketMcpRecord = {
  item: MarketItemSummary;
  versions: MarketItemVersion[];
  /** The latest version's README; null when it cannot be told. */
  readme: MarketMcpReadme | null;
  /** The latest version's AI overview; null when there is none to show. */
  aiOverview: MarketMcpAiOverview | null;
  /** False when the page stays out of search: see `mcpReadmeSharedOf`. */
  searchIndexable: boolean;
  /**
   * The servers integrating the same product, the product's own server first
   * (Issue #367, W8); null when not asked for (`relatedProduct` option) or
   * when no official server exists for the brand.
   */
  relatedProduct: MarketMcpProductGroup | null;
  /** The latest version's quality scorecard; null without a version to score. */
  score: MarketMcpScore | null;
  /**
   * The current revision of the source whose tool list is shown (Issue #367,
   * tool revisions); null when that list has no history. Detail only.
   */
  toolsRevision: MarketMcpToolsRevision | null;
};

/**
 * A version row without its README text: list and detail reads load many
 * versions, and only the latest one's README is ever shown (and that one on
 * its own, see `findMcp`).
 */
const versionColumns = {
  id: mcpServerVersions.id,
  serverId: mcpServerVersions.serverId,
  version: mcpServerVersions.version,
  status: mcpServerVersions.status,
  manifestJson: mcpServerVersions.manifestJson,
  provenanceJson: mcpServerVersions.provenanceJson,
  publishedAt: mcpServerVersions.publishedAt,
  createdAt: mcpServerVersions.createdAt,
};

type VersionRow = Pick<
  typeof mcpServerVersions.$inferSelect,
  keyof typeof versionColumns
>;

function iso(value: Date | null) {
  return value ? value.toISOString() : null;
}

export function identifierForSearch(identifier: string) {
  return identifier.toLowerCase().replace(/^(?:io|com)\.github\./, "");
}

function queryIncludesTechnicalIdentifierSyntax(query: string) {
  return query.includes(".") || query.includes("/");
}

function marketSearchCondition(query: string) {
  const normalizedIdentifier = sql<string>`regexp_replace(${mcpServers.identifier}, '^(io|com)\\.github\\.', '', 'i')`;
  const conditions = [
    ilike(mcpServers.name, `%${query}%`),
    ilike(mcpServers.summary, `%${query}%`),
    ilike(normalizedIdentifier, `%${query}%`),
  ];
  if (queryIncludesTechnicalIdentifierSyntax(query)) {
    conditions.push(ilike(mcpServers.identifier, `%${query}%`));
  }
  return or(...conditions)!;
}

// Category slugs cannot contain commas; multiple slugs select their union.
export function parseMcpCategoryFilter(category?: string): string[] {
  return [
    ...new Set(
      category
        ?.split(",")
        .map((slug) => slug.trim())
        .filter(Boolean) ?? [],
    ),
  ];
}

function stringMeta(
  value: Record<string, unknown> | null | undefined,
  key: string,
) {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : null;
}

function transportMeta(
  value: Record<string, unknown> | null | undefined,
): McpTransport | null {
  const transport = value?.transport;
  if (typeof transport !== "string") {
    return null;
  }
  // Validate against the contract enum rather than casting a stray string
  // straight into the transport type.
  const parsed = mcpTransportSchema.safeParse(transport);
  return parsed.success ? parsed.data : null;
}

function toManifestMeta(value: Record<string, unknown> | null | undefined) {
  const official = value?.official;
  const verified = value?.verified;
  const desktopOnly = value?.desktopOnly;
  const webExecutable = value?.webExecutable;
  const requiresAuth = value?.requiresAuth;
  // The latest manifest's tools are the count's source of truth: a job that
  // fills them after the sync (the stdio validation) writes the manifest and
  // the server's `toolsCount`, but a re-sync restamps the latter from the
  // registry entry, which lists no tools.
  const tools = value?.tools;
  const toolsCount = Array.isArray(tools) ? tools.length : value?.toolsCount;
  return {
    official: typeof official === "boolean" ? official : false,
    verified: typeof verified === "boolean" ? verified : false,
    desktopOnly: typeof desktopOnly === "boolean" ? desktopOnly : false,
    webExecutable: typeof webExecutable === "boolean" ? webExecutable : true,
    requiresAuth: typeof requiresAuth === "boolean" ? requiresAuth : false,
    toolsCount:
      typeof toolsCount === "number" && Number.isFinite(toolsCount)
        ? Math.max(0, Math.trunc(toolsCount))
        : 0,
  };
}

/**
 * The latest version's failed stdio validation, shown in place of "0 tools"
 * (Issue #367, W1b): only while the version has no tools, and only the
 * fields a card needs — the detail stays in the version's provenance.
 */
function toolsValidationOf(
  provenanceJson: Record<string, unknown> | null | undefined,
  toolsCount: number,
): MarketMcpToolsValidation | null {
  if (toolsCount > 0) return null;
  const parsed = marketMcpToolsValidationSchema.safeParse(
    provenanceJson?.validation,
  );
  return parsed.success ? parsed.data : null;
}

function mergeMetaSources(
  rowMeta: Record<string, unknown> | null | undefined,
  manifestJson?: Record<string, unknown> | null,
) {
  return {
    ...(manifestJson ?? {}),
    ...(rowMeta ?? {}),
  };
}

function runtimeFor(input: { desktopOnly: boolean; webExecutable: boolean }) {
  if (input.desktopOnly && input.webExecutable) {
    return "hybrid" as const;
  }
  return input.desktopOnly || !input.webExecutable ? "desktop" : "web";
}

function verificationStatusFor(input: {
  official: boolean;
  verified: boolean;
}) {
  if (input.official) {
    return "official" as const;
  }
  return input.verified ? "verified" : "unverified";
}

/**
 * The item's logo and where it came from. A manifest the icon chain wrote
 * (`icons/chain.ts`, federation since #367) carries both. Older manifests
 * carry at most a registry icon, so a missing logo is derived the way the
 * chain's third step would: the GitHub avatar of the `io.github.<owner>`
 * namespace or of the declared repository's owner. The <img> follows
 * github.com's redirect to the avatar CDN and the client falls back to the
 * placeholder on load error, so a wrong guess is safe.
 */
export function itemIcon(input: {
  meta: Record<string, unknown>;
  repoUrl: string | null;
  identifier: string;
}): { iconUrl: string | null; iconSource: MarketMcpIconSource } {
  const iconUrl = stringMeta(input.meta, "iconUrl");
  const stored = marketMcpIconSourceSchema.safeParse(input.meta.iconSource);
  if (stored.success) {
    return iconUrl
      ? { iconUrl, iconSource: stored.data }
      : { iconUrl: null, iconSource: "placeholder" };
  }
  if (iconUrl) {
    return { iconUrl, iconSource: "registry" };
  }
  const owner = githubOwner({
    namespace: input.identifier.split("/")[0] ?? input.identifier,
    repositoryUrl: input.repoUrl,
  });
  return owner
    ? { iconUrl: githubAvatarUrl(owner), iconSource: "github-avatar" }
    : { iconUrl: null, iconSource: "placeholder" };
}

function mapItemRow(input: {
  row: typeof mcpServers.$inferSelect;
  categories: string[];
  latestVersion?: string | null;
  latestManifestJson?: Record<string, unknown> | null;
  latestProvenanceJson?: Record<string, unknown> | null;
  /**
   * Whom the summary is read for: the Chinese translation (stored on the
   * version's provenance by the translation pass) shows only to a Chinese
   * locale and only while the entry has no AI overview.
   */
  translation?: { locale: string | undefined; hasOverview: boolean };
}): MarketItemSummary {
  const mergedMeta = mergeMetaSources(
    input.row.metadataJson,
    input.latestManifestJson,
  );
  const meta = toManifestMeta(mergedMeta);
  // The license and language come from the entry's repository and packages,
  // not from the blob alone; a hosted service has neither.
  const listing = resolveListingMetadata({
    manifestJson: input.latestManifestJson,
    provenanceJson: input.latestProvenanceJson,
    repoUrl: input.row.repoUrl,
  });
  const translationRecord =
    input.latestProvenanceJson?.[MCP_SUMMARY_TRANSLATION_KEY];
  return {
    id: input.row.id,
    identifier: input.row.identifier,
    name: input.row.name,
    summary: input.row.summary,
    providerName: stringMeta(mergedMeta, "providerName") ?? input.row.owner,
    homepageUrl: stringMeta(mergedMeta, "homepageUrl"),
    ...itemIcon({
      meta: mergedMeta,
      repoUrl: input.row.repoUrl,
      identifier: input.row.identifier,
    }),
    sourceUrl: input.row.sourceUrl,
    repoUrl: input.row.repoUrl,
    license: listing.hostedOnly
      ? null
      : (listing.license ?? normaliseLicense(stringMeta(mergedMeta, "license"))),
    language: listing.hostedOnly
      ? null
      : (listing.language ??
        normaliseLanguage(stringMeta(mergedMeta, "language"))),
    status: input.row.status,
    visibility: input.row.visibility,
    categories: input.categories,
    latestVersion: input.latestVersion ?? null,
    transport: transportMeta(mergedMeta),
    official: meta.official,
    verified: meta.verified,
    verificationStatus: verificationStatusFor(meta),
    desktopOnly: meta.desktopOnly,
    webExecutable: meta.webExecutable,
    runtime: runtimeFor(meta),
    requiresAuth: meta.requiresAuth,
    toolsCount: meta.toolsCount,
    toolsValidation: toolsValidationOf(
      input.latestProvenanceJson,
      meta.toolsCount,
    ),
    lastIndexedAt: stringMeta(mergedMeta, "lastIndexedAt"),
    createdAt: input.row.createdAt.toISOString(),
    updatedAt: input.row.updatedAt.toISOString(),
    publishedAt: iso(input.row.publishedAt),
    publisher: publisherMeta(mergedMeta),
    descriptionLanguage: descriptionLanguageFor({
      summary: input.row.summary,
      record: translationRecord,
    }),
    localizedSummary: input.translation
      ? localizedSummaryFor({
          locale: input.translation.locale,
          summary: input.row.summary,
          hasOverview: input.translation.hasOverview,
          record: translationRecord,
        })
      : null,
  };
}

function mapVersionRow(row: VersionRow): MarketItemVersion {
  return {
    version: row.version,
    status: row.status,
    manifestJson: row.manifestJson,
    provenanceJson: row.provenanceJson ?? {},
    publishedAt: iso(row.publishedAt),
  };
}

async function categoriesByItemIds(itemIds: string[]) {
  if (itemIds.length === 0) {
    return new Map<string, string[]>();
  }
  const rows = await db
    .select({
      serverId: mcpServerCategories.serverId,
      slug: mcpCategories.slug,
    })
    .from(mcpServerCategories)
    .innerJoin(
      mcpCategories,
      eq(mcpCategories.id, mcpServerCategories.categoryId),
    )
    .where(inArray(mcpServerCategories.serverId, itemIds));

  const map = new Map<string, string[]>();
  for (const row of rows) {
    const existing = map.get(row.serverId) ?? [];
    existing.push(row.slug);
    map.set(row.serverId, existing);
  }
  return map;
}

type LatestVersion = {
  id: string;
  manifestJson: Record<string, unknown>;
  provenanceJson: Record<string, unknown>;
  version: string;
};

async function latestVersionsByItemIds(itemIds: string[]) {
  if (itemIds.length === 0) {
    return new Map<string, LatestVersion>();
  }
  const rows = await db
    .select({
      id: mcpServerVersions.id,
      serverId: mcpServerVersions.serverId,
      version: mcpServerVersions.version,
      manifestJson: mcpServerVersions.manifestJson,
      provenanceJson: mcpServerVersions.provenanceJson,
    })
    .from(mcpServerVersions)
    .where(
      and(
        inArray(mcpServerVersions.serverId, itemIds),
        eq(mcpServerVersions.status, "published"),
      ),
    )
    // Deterministic "latest": newest published first, so the first row we keep
    // per item is stable rather than whatever order Postgres returns.
    .orderBy(
      desc(mcpServerVersions.publishedAt),
      desc(mcpServerVersions.createdAt),
    );

  const map = new Map<string, LatestVersion>();
  for (const row of rows) {
    if (!map.has(row.serverId)) {
      map.set(row.serverId, {
        id: row.id,
        manifestJson: row.manifestJson,
        provenanceJson: row.provenanceJson,
        version: row.version,
      });
    }
  }
  return map;
}

/**
 * The AI summary (in `locale`, English fallback) and the visible overview
 * languages of each latest version; one query each for the whole page.
 */
async function overviewFieldsByVersionIds(
  versionIds: string[],
  locale: MarketMcpLocale,
) {
  const [overviews, locales] = await Promise.all([
    readMcpOverviews({ versionIds, locale }),
    readMcpOverviewLocales(versionIds),
  ]);
  return (versionId: string | undefined) => ({
    aiSummary: versionId
      ? (overviews.get(versionId)?.overview.summary ?? null)
      : null,
    overviewLocales: versionId ? (locales.get(versionId) ?? []) : [],
  });
}

/** Shared by catalog reads and sitemap export, including desktop-only details. */
export function publicMarketMcpCondition(
  servers: Record<"status" | "visibility", AnyPgColumn> = mcpServers,
) {
  return and(
    eq(servers.status, "published"),
    eq(servers.visibility, "public"),
  )!;
}

/**
 * How many public servers have to show one README file before their pages stay
 * out of search. A batch publisher registers hundreds of servers from one
 * repository whose README lists them all; each page would be that same
 * document. A few servers sharing a monorepo README stay below this.
 */
const MCP_SHARED_README_MIN_SERVERS = 10;

// A raw `sql` FROM renders an alias by its name alone, so the tables are named
// in the FROM and the aliases only supply the column references.
const OTHER_SERVERS = "shared_readme_servers";
const OTHER_VERSIONS = "shared_readme_versions";
const OWN_VERSION = "shared_readme_own";
const otherServers = alias(mcpServers, OTHER_SERVERS);
const otherVersions = alias(mcpServerVersions, OTHER_VERSIONS);
const ownVersion = alias(mcpServerVersions, OWN_VERSION);

/**
 * True when version `versionId` (a value or a column reference) has a README
 * whose bytes (sha256) the shown version of at least
 * `MCP_SHARED_README_MIN_SERVERS` public servers also has, its own server
 * included. Such a page is `noindex`. For one server: counting stops at the
 * threshold and the README hash index finds the candidates. A whole-catalog
 * read uses `mcpSharedReadmeServerIds` instead, the same rule as a set —
 * evaluated per row, this walks every older version of every batch server.
 */
export function mcpReadmeSharedOf(versionId: unknown): SQL<boolean> {
  return sql<boolean>`((
    select count(*) from (
      select 1
      from ${mcpServerVersions} as ${sql.identifier(OTHER_VERSIONS)}
      inner join ${mcpServers} as ${sql.identifier(OTHER_SERVERS)}
        on ${otherServers.id} = ${otherVersions.serverId}
      where ${otherVersions.readmeStatus} = 'ok'
        and ${otherVersions.readmeSha256} = (
          select ${ownVersion.readmeSha256}
          from ${mcpServerVersions} as ${sql.identifier(OWN_VERSION)}
          where ${ownVersion.id} = ${versionId}
            and ${ownVersion.readmeStatus} = 'ok'
        )
        and ${publicMarketMcpCondition(otherServers)}
        and ${otherVersions.id} = ${latestPublishedVersionOf(otherServers.id)}
      limit ${MCP_SHARED_README_MIN_SERVERS}
    ) as shared
  ) >= ${MCP_SHARED_README_MIN_SERVERS})`;
}

const SHOWN_VERSIONS = "shared_readme_shown";

/**
 * The ids of the public servers `mcpReadmeSharedOf` is true for, as one
 * uncorrelated subquery the database computes once per statement: each public
 * server's shown version (its newest published one, ordered as
 * `latestPublishedVersionOf` orders), grouped by README hash. The sitemap
 * leaves these servers out.
 */
export function mcpSharedReadmeServerIds(): SQL {
  return sql`(
    with ${sql.identifier(SHOWN_VERSIONS)} as (
      select distinct on (${otherVersions.serverId})
        ${otherVersions.serverId} as server_id,
        ${otherVersions.readmeStatus} as readme_status,
        ${otherVersions.readmeSha256} as readme_sha256
      from ${mcpServerVersions} as ${sql.identifier(OTHER_VERSIONS)}
      inner join ${mcpServers} as ${sql.identifier(OTHER_SERVERS)}
        on ${otherServers.id} = ${otherVersions.serverId}
      where ${otherVersions.status} = 'published'
        and ${publicMarketMcpCondition(otherServers)}
      order by ${otherVersions.serverId},
        ${otherVersions.publishedAt} desc,
        ${otherVersions.createdAt} desc
    )
    select server_id from ${sql.identifier(SHOWN_VERSIONS)}
    where readme_status = 'ok'
      and readme_sha256 in (
        select readme_sha256 from ${sql.identifier(SHOWN_VERSIONS)}
        where readme_status = 'ok'
        group by readme_sha256
        having count(*) >= ${MCP_SHARED_README_MIN_SERVERS}
      )
  )`;
}

/**
 * 1 when the server's publisher also runs its endpoint
 * (`metadata_json.publisher.endpointMatch`), else 0. A search ranks these
 * first: for "notion", the server com.notion publishes at mcp.notion.com
 * stands above every third-party Notion server. Read from the promoted
 * metadata rather than a column: it only orders the rows a query already
 * matched, which is never the whole catalog.
 */
export function publisherEndpointMatchRank(
  brandDomains: readonly string[] = [],
) {
  if (brandDomains.length === 0) {
    return sql<number>`(case when ${mcpServers.metadataJson} #>> '{publisher,endpointMatch}' = 'true' then 1 else 0 end)`;
  }
  const domains = sql.join(
    brandDomains.map((domain) => sql`${domain}`),
    sql`, `,
  );
  return sql<number>`(case when ${mcpServers.metadataJson} #>> '{publisher,endpointMatch}' = 'true' then (case when ${mcpServers.metadataJson} #>> '{publisher,domain}' in (${domains}) then 2 else 1 end) else 0 end)`;
}

/**
 * The rank `publisherEndpointMatchRank(brandDomains)` gives a row, computed
 * in code for the cursor: 2 for an endpoint-matched server published under a
 * domain whose brand is the query, 1 for any other endpoint-matched one.
 */
export function publisherRankOf(
  metadataJson: Record<string, unknown> | null | undefined,
  brandDomains: readonly string[],
): 0 | 1 | 2 {
  const publisher = publisherMeta(metadataJson);
  if (!publisher?.endpointMatch) {
    return 0;
  }
  return brandDomains.includes(publisher.domain) ? 2 : 1;
}

type ListCursor = { endpointMatch: 0 | 1 | 2; publishedAt: Date; id: string };

// Keyset cursor over the (endpointMatch desc, publishedAt desc, id desc)
// ordering; without a query the first key is a constant 0 and the browse
// index serves the rest. Opaque to callers; encodes the last row of the
// previous page so the next page is a plain range scan rather than an offset
// that grows with the catalog.
export function encodeListCursor(
  endpointMatch: 0 | 1 | 2,
  publishedAt: Date | null,
  id: string,
): string {
  const millis = publishedAt ? publishedAt.getTime() : 0;
  return Buffer.from(`${endpointMatch}|${millis}|${id}`).toString("base64url");
}

export function decodeListCursor(
  cursor: string | undefined,
): ListCursor | null {
  if (!cursor) {
    return null;
  }
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const parts = decoded.split("|");
    // A cursor from before the rank key had two parts; its page continues
    // among the unranked rows, which it was already among.
    const [endpointMatch, millisText, id] =
      parts.length === 2 ? ["0", parts[0], parts[1]] : parts;
    if (parts.length < 2 || parts.length > 3) {
      return null;
    }
    const millis = Number(millisText);
    // Beyond ±8.64e15 ms, new Date() is an Invalid Date, which the pg driver
    // serializes into a literal Postgres rejects — a crafted cursor 500. Treat
    // out-of-range like malformed base64: fall back to page one.
    if (
      (endpointMatch !== "0" &&
        endpointMatch !== "1" &&
        endpointMatch !== "2") ||
      !Number.isFinite(millis) ||
      Math.abs(millis) > 8.64e15 ||
      !id
    ) {
      return null;
    }
    return {
      endpointMatch: endpointMatch === "2" ? 2 : endpointMatch === "1" ? 1 : 0,
      publishedAt: new Date(millis),
      id,
    };
  } catch {
    return null;
  }
}

export async function listMcp(input: {
  query?: string;
  category?: string;
  transport?: McpTransport;
  official?: boolean;
  verified?: boolean;
  runtime?: McpRuntime;
  includeDesktopOnly?: boolean;
  desktopOnly?: boolean;
  limit?: number;
  cursor?: string;
  // Language of each item's `aiSummary`; English when not given.
  locale?: MarketMcpLocale;
}) {
  const query = input.query?.trim().toLowerCase();
  const categories = parseMcpCategoryFilter(input.category);
  const limit = Math.max(1, Math.min(input.limit ?? 50, 100));

  // Everything is pushed into SQL — facets are real columns and categories join
  // — so the whole catalog is filtered/ordered/paginated in the database. No
  // in-memory scan cap, so results are complete at any catalog size.
  const conditions = [publicMarketMcpCondition()];
  if (query) {
    conditions.push(marketSearchCondition(query));
  }
  if (typeof input.desktopOnly === "boolean") {
    conditions.push(eq(mcpServers.desktopOnly, input.desktopOnly));
  } else if (!input.includeDesktopOnly) {
    conditions.push(eq(mcpServers.desktopOnly, false));
  }
  if (input.transport) {
    conditions.push(eq(mcpServers.transport, input.transport));
  }
  if (typeof input.official === "boolean") {
    conditions.push(eq(mcpServers.official, input.official));
  }
  if (typeof input.verified === "boolean") {
    conditions.push(eq(mcpServers.verified, input.verified));
  }
  if (input.runtime) {
    conditions.push(eq(mcpServers.runtime, input.runtime));
  }
  if (categories.length > 0) {
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(mcpServerCategories)
          .innerJoin(
            mcpCategories,
            eq(mcpCategories.id, mcpServerCategories.categoryId),
          )
          .where(
            and(
              eq(mcpServerCategories.serverId, mcpServers.id),
              inArray(mcpCategories.slug, categories),
            ),
          ),
      ),
    );
  }
  // A search ranks servers whose publisher runs the endpoint first, those
  // among them published under the queried brand's own domain above the
  // rest; the default browse stays in publication order, which its index
  // serves.
  const brandDomains = query ? await findBrandPublisherDomains(query) : [];
  const rank = query ? publisherEndpointMatchRank(brandDomains) : null;
  const cursor = decodeListCursor(input.cursor);
  if (cursor) {
    // Next page in the (rank desc, publishedAt desc, id desc) ordering: rows
    // strictly after the cursor row, via a row-value comparison the browse
    // index can serve when there is no rank key.
    conditions.push(
      rank
        ? sql`(${rank}, ${mcpServers.publishedAt}, ${mcpServers.id}) < (${cursor.endpointMatch}, ${cursor.publishedAt}, ${cursor.id})`
        : sql`(${mcpServers.publishedAt}, ${mcpServers.id}) < (${cursor.publishedAt}, ${cursor.id})`,
    );
  }

  // A storage failure is not an empty catalog; let the API return a 5xx.
  const dbRows = await db
    .select()
    .from(mcpServers)
    .where(and(...conditions))
    .orderBy(
      ...(rank ? [desc(rank)] : []),
      desc(mcpServers.publishedAt),
      desc(mcpServers.id),
    )
    .limit(limit + 1);

  const hasMore = dbRows.length > limit;
  const pageRows = hasMore ? dbRows.slice(0, limit) : dbRows;
  const itemIds = pageRows.map((row) => row.id);
  const categoryMap = await categoriesByItemIds(itemIds);
  const latestVersionMap = await latestVersionsByItemIds(itemIds);
  const [overviewFields, ownerLayers] = await Promise.all([
    overviewFieldsByVersionIds(
      [...latestVersionMap.values()].map((latest) => latest.id),
      input.locale ?? "en",
    ),
    findOwnerLayersByServerIds(itemIds),
  ]);
  const items = pageRows.map((row) => {
    const latest = latestVersionMap.get(row.id);
    const overview = overviewFields(latest?.id);
    // A verified owner's corrections sit on top of the federated data
    // (Issue #367, W7; ./claims/overrides.ts).
    return {
      ...applyOwnerOverridesToItem(
        mapItemRow({
          row,
          categories: categoryMap.get(row.id) ?? [],
          latestManifestJson: latest?.manifestJson,
          latestProvenanceJson: latest?.provenanceJson,
          latestVersion: latest?.version ?? null,
          translation: {
            locale: input.locale,
            hasOverview: overview.overviewLocales.length > 0,
          },
        }),
        ownerLayers.get(row.id) ?? { row: null, claimed: false },
      ),
      ...overview,
    };
  });
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeListCursor(
          query ? publisherRankOf(last.metadataJson, brandDomains) : 0,
          last.publishedAt,
          last.id,
        )
      : null;
  return { items, nextCursor };
}

// Facet counts for the category sidebar: how many published/public MCP items
// fall in each category for the CURRENT query, computed over the whole catalog
// (not just a loaded page) and independent of any selected category so the
// numbers stay stable while the user narrows down. `total` is the distinct item
// count for the query; per-category counts can sum past it because one item may
// belong to several categories.
export async function countMcpByCategory(input: {
  query?: string;
  includeDesktopOnly?: boolean;
  desktopOnly?: boolean;
}): Promise<{ counts: Record<string, number>; total: number }> {
  const query = input.query?.trim().toLowerCase();
  const conditions = [publicMarketMcpCondition()];
  if (query) {
    conditions.push(marketSearchCondition(query));
  }
  if (typeof input.desktopOnly === "boolean") {
    conditions.push(eq(mcpServers.desktopOnly, input.desktopOnly));
  } else if (!input.includeDesktopOnly) {
    conditions.push(eq(mcpServers.desktopOnly, false));
  }

  const [categoryRows, totalRows] = await Promise.all([
    db
      .select({
        slug: mcpCategories.slug,
        count: sql<number>`count(distinct ${mcpServers.id})::int`,
      })
      .from(mcpServers)
      .innerJoin(
        mcpServerCategories,
        eq(mcpServerCategories.serverId, mcpServers.id),
      )
      .innerJoin(
        mcpCategories,
        eq(mcpCategories.id, mcpServerCategories.categoryId),
      )
      .where(and(...conditions))
      .groupBy(mcpCategories.slug),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(mcpServers)
      .where(and(...conditions)),
  ]);
  const counts: Record<string, number> = {};
  for (const row of categoryRows) {
    counts[row.slug] = Number(row.count);
  }
  return { counts, total: Number(totalRows[0]?.count ?? 0) };
}

/**
 * The product group `row` belongs to, its members mapped as listing items
 * (with the AI summary in `locale`) and flagged by whether their own
 * publisher runs their endpoint. The row itself is among the members.
 */
async function relatedProductOf(
  row: typeof mcpServers.$inferSelect,
  locale: MarketMcpLocale,
): Promise<MarketMcpProductGroup | null> {
  const found = await findProductGroupMembers(row);
  if (!found) {
    return null;
  }
  const { group, rows } = found;
  const itemIds = rows.map((member) => member.id);
  const [categoryMap, latestVersionMap, ownerLayers] = await Promise.all([
    categoriesByItemIds(itemIds),
    latestVersionsByItemIds(itemIds),
    findOwnerLayersByServerIds(itemIds),
  ]);
  const overviewFields = await overviewFieldsByVersionIds(
    [...latestVersionMap.values()].map((latest) => latest.id),
    locale,
  );
  return {
    domain: group.domain,
    brand: group.brand,
    officialIdentifier: group.officialIdentifier,
    members: rows.map((member) => {
      const latest = latestVersionMap.get(member.id);
      const overview = overviewFields(latest?.id);
      return {
        // The same owner layer as the catalog list (Issue #367, W7).
        ...applyOwnerOverridesToItem(
          mapItemRow({
            row: member,
            categories: categoryMap.get(member.id) ?? [],
            latestManifestJson: latest?.manifestJson,
            latestProvenanceJson: latest?.provenanceJson,
            latestVersion: latest?.version ?? null,
            translation: {
              locale,
              hasOverview: overview.overviewLocales.length > 0,
            },
          }),
          ownerLayers.get(member.id) ?? { row: null, claimed: false },
        ),
        ...overview,
        publisherMatch: isOfficialEntry(productGroupEntryOf(member)),
      };
    }),
  };
}

/**
 * A published, public server with its published versions (newest first),
 * the latest one's README, and its AI overview in `locale` (English when not
 * given, and the fallback when that language has none or it is hidden).
 * With `relatedProduct`, also its product group: two more catalog scans,
 * which only the public detail asks for — the manifest reads that share this
 * function would discard them.
 */
export async function findMcp(
  identifier: string,
  options: {
    locale?: MarketMcpLocale;
    relatedProduct?: boolean;
    /** Read the tools revision too (detail only; one more query). */
    toolsRevision?: boolean;
    /**
     * Show the platform's snapshot or members' observation as the manifest's
     * tools (Issue #367). For what a visitor sees only (the detail and the
     * manifest route). Never for installs: what they seed into a workspace is
     * the registry's, a probe's or the owner's list, not an observation.
     */
    referenceTools?: boolean;
  } = {},
): Promise<MarketMcpRecord | null> {
  // Preserve database errors: returning null here would turn an outage into 404.
  const [row] = await db
    .select()
    .from(mcpServers)
    .where(
      and(eq(mcpServers.identifier, identifier), publicMarketMcpCondition()),
    )
    .limit(1);
  if (row) {
    // Only ever expose published versions on the public API. Loading drafts
    // here would let a consumer install an unpublished version by naming it,
    // and would leak its manifest. Newest published first.
    const versions = await db
      .select(versionColumns)
      .from(mcpServerVersions)
      .where(
        and(
          eq(mcpServerVersions.serverId, row.id),
          eq(mcpServerVersions.status, "published"),
        ),
      )
      .orderBy(
        desc(mcpServerVersions.publishedAt),
        desc(mcpServerVersions.createdAt),
      );
    const [categoryMap, ownerLayers] = await Promise.all([
      categoriesByItemIds([row.id]),
      findOwnerLayersByServerIds([row.id]),
    ]);
    const ownerLayer = ownerLayers.get(row.id) ?? { row: null, claimed: false };
    const latest = versions[0];
    // The platform's snapshot or the members' observation fills in for a
    // server whose owner has not listed its tools and whose registry entry or
    // probe found none (Issue #367).
    const ownerToolsVisible =
      ownerSubmittedTools(ownerLayer.row?.toolsJson).length > 0;
    const base = baseToolsOf(latest?.manifestJson);
    const [toolsRevision, referenceTools] = await Promise.all([
      options.toolsRevision
        ? readToolsRevision(row.id, ownerToolsVisible, base)
        : null,
      options.referenceTools
        ? readReferenceTools(row.id, ownerToolsVisible, base)
        : null,
    ]);
    const withReference = (manifestJson: Record<string, unknown>) =>
      applyReferenceToolsToManifest(
        applyOwnerOverridesToManifest(manifestJson, ownerLayer.row),
        referenceTools,
      );
    const locale = options.locale ?? "en";
    const [[readme, overviews, overviewLocales, readmeShared], relatedProduct] =
      await Promise.all([
        latest
          ? Promise.all([
              readMcpReadme(latest.id),
              readMcpOverviews({ versionIds: [latest.id], locale }),
              readMcpOverviewLocales([latest.id]),
              db
                .execute<{
                  shared: boolean;
                }>(sql`select ${mcpReadmeSharedOf(latest.id)} as shared`)
                .then((result) => result.rows[0]?.shared === true),
            ])
          : ([null, null, null, false] as const),
        options.relatedProduct ? relatedProductOf(row, locale) : null,
      ]);
    const aiOverview = latest ? (overviews?.get(latest.id) ?? null) : null;
    // The owner's corrections (Issue #367, W7) are the top layer of the item
    // and of every published version's manifest, so the manifest route, the
    // page and the scorecard agree whichever version is asked for.
    const ownerItem = applyOwnerOverridesToItem(
      mapItemRow({
        row,
        categories: categoryMap.get(row.id) ?? [],
        latestManifestJson: latest?.manifestJson,
        latestProvenanceJson: latest?.provenanceJson,
        latestVersion: latest?.version ?? null,
        translation: {
          locale,
          hasOverview:
            (latest ? (overviewLocales?.get(latest.id)?.length ?? 0) : 0) > 0,
        },
      }),
      ownerLayer,
    );
    const item = referenceTools
      ? {
          ...ownerItem,
          toolsCount: referenceTools.tools.length,
          toolsValidation: null,
        }
      : ownerItem;
    return {
      item: {
        ...item,
        aiSummary: aiOverview?.overview.summary ?? null,
        overviewLocales: latest ? (overviewLocales?.get(latest.id) ?? []) : [],
      },
      versions: versions.map((version) => ({
        ...mapVersionRow(version),
        manifestJson: withReference(version.manifestJson),
      })),
      readme: readme
        ? mcpReadmeView({ repoUrl: row.repoUrl, ...readme })
        : null,
      aiOverview: aiOverview
        ? {
            summary: aiOverview.overview.summary,
            whatItDoes: aiOverview.overview.whatItDoes,
            whenToUse: aiOverview.overview.whenToUse,
            requirements: aiOverview.overview.requirements,
            cautions: aiOverview.overview.cautions?.trim()
              ? aiOverview.overview.cautions
              : null,
            locale: aiOverview.locale,
            generatedAt: aiOverview.generatedAt.toISOString(),
          }
        : null,
      searchIndexable: !readmeShared,
      relatedProduct,
      // Computed on read from the rows already loaded (Issue #367, W6): the
      // icon is the one the catalog shows, derived or stored; the manifest
      // carries the owner's layer (W7), so owner corrections count.
      score: latest
        ? scoreMcp({
            manifestJson: withReference(latest.manifestJson),
            provenanceJson: latest.provenanceJson,
            readmeStatus: readme?.readmeStatus ?? null,
            // Any visible overview language, not only the one asked for.
            hasAiOverview:
              (latest ? (overviewLocales?.get(latest.id)?.length ?? 0) : 0) > 0,
            iconUrl: item.iconUrl,
            iconSource: item.iconSource,
          })
        : null,
      toolsRevision,
    };
  }
  return null;
}

/**
 * One page of a public listing's tool-revision history, newest first; null
 * when there is no such listing. The source defaults to the one whose tools the
 * page shows.
 */
export async function listMcpToolRevisions(
  identifier: string,
  query: ListMarketMcpToolRevisionsRequest,
): Promise<ListMarketMcpToolRevisionsResponse | null> {
  const [row] = await db
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(
      and(eq(mcpServers.identifier, identifier), publicMarketMcpCondition()),
    )
    .limit(1);
  if (!row) return null;
  const [ownerLayers, latestVersion] = await Promise.all([
    findOwnerLayersByServerIds([row.id]),
    latestVersionsByItemIds([row.id]),
  ]);
  return readToolRevisionsPage({
    itemId: row.id,
    ownerToolsVisible:
      ownerSubmittedTools(ownerLayers.get(row.id)?.row?.toolsJson).length > 0,
    base: baseToolsOf(latestVersion.get(row.id)?.manifestJson),
    limit: query.limit,
    before: query.before,
  });
}

export async function findMcpVersion(
  identifier: string,
  version?: string,
  options: { referenceTools?: boolean } = {},
) {
  const record = await findMcp(identifier, {
    referenceTools: options.referenceTools,
  });
  if (!record) {
    return null;
  }
  const selectedVersion =
    version ??
    record.item.latestVersion ??
    record.versions.find((candidate) => candidate.status === "published")
      ?.version;
  const itemVersion =
    record.versions.find(
      (candidate) => candidate.version === selectedVersion,
    ) ?? null;
  return itemVersion ? { record, itemVersion } : null;
}
