import { eq, inArray, sql } from "drizzle-orm";
import type { MarketMcpManifest } from "@sourceweft/market-contracts";
import {
  db,
  mcpCategories,
  mcpServerCategories,
  mcpServers,
  mcpServerVersions,
} from "@sourceweft/db";
import type { McpRepositoryIngestOptions } from "../types";
import { getMcpCategoryDefinition } from "../parser/categories";
import { carryOverMcpReadme } from "../readme/readme-repository";
import { hashId, mcpServerId, mcpServerVersionId } from "./plan";

function categoryName(slug: string) {
  const definition = getMcpCategoryDefinition(slug);
  if (definition) {
    return definition.name;
  }
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function categoryDescription(slug: string) {
  return (
    getMcpCategoryDefinition(slug)?.description ??
    `MCP category: ${categoryName(slug)}`
  );
}

/** The catalog row id of an MCP category, from its slug. */
export function mcpCategoryId(slug: string) {
  return hashId("mcp-cat", slug);
}

/** The database, or a transaction on it. */
type Executor = Pick<typeof db, "insert">;

/**
 * Makes sure an `mcp_categories` row exists for each slug, with the
 * taxonomy's current name and description, in one statement; returns their
 * ids in slug order, without repeats. Federation and the AI overview both
 * call this concurrently, so every writer locks the rows in that one order.
 */
export async function upsertMcpCategories(
  executor: Executor,
  slugs: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(slugs)].sort();
  if (unique.length === 0) return [];
  await executor
    .insert(mcpCategories)
    .values(
      unique.map((slug) => ({
        id: mcpCategoryId(slug),
        slug,
        name: categoryName(slug),
        description: categoryDescription(slug),
      })),
    )
    .onConflictDoUpdate({
      target: mcpCategories.slug,
      set: {
        name: sql`excluded.name`,
        description: sql`excluded.description`,
      },
    });
  return unique.map(mcpCategoryId);
}

function metadataFromManifest(manifest: MarketMcpManifest) {
  return {
    official: manifest.official,
    verified: manifest.verified,
    desktopOnly: manifest.desktopOnly,
    webExecutable: manifest.webExecutable,
    requiresAuth: manifest.auth.required,
    transport: manifest.transport,
    providerName: manifest.providerName,
    homepageUrl: manifest.homepageUrl,
    iconUrl: manifest.iconUrl,
    license: manifest.license,
    language: manifest.language,
    toolsCount: manifest.tools.length,
    lastIndexedAt: manifest.lastIndexedAt ?? new Date().toISOString(),
  };
}

type McpServerStatus = McpRepositoryIngestOptions["status"];
type McpServerVisibility = McpRepositoryIngestOptions["visibility"];

/**
 * Derive the promoted facet columns from the final metadata blob, so listing can
 * filter/sort in SQL. Mirrors read-repository's runtimeFor/toManifestMeta
 * defaults (desktopOnly/official/verified default false, webExecutable defaults
 * true) and is fed the same metadataJson the row stores — including the
 * submitted-origin official/verified overrides.
 */
function facetsFromMetadata(metadataJson: Record<string, unknown>) {
  const transport =
    typeof metadataJson.transport === "string" ? metadataJson.transport : null;
  const official = metadataJson.official === true;
  const verified = metadataJson.verified === true;
  const desktopOnly = metadataJson.desktopOnly === true;
  const webExecutable = metadataJson.webExecutable !== false;
  const runtime =
    desktopOnly && webExecutable
      ? "hybrid"
      : desktopOnly || !webExecutable
        ? "desktop"
        : "web";
  return { transport, official, verified, desktopOnly, runtime };
}

/**
 * Ownership/state of an existing catalog item, used to guard submissions
 * against overwriting federated (upstream) entries or hijacking another
 * submitter's published listing, and to keep a flagged identifier sticky in
 * review.
 */
export async function getMarketItemForSubmission(identifier: string): Promise<{
  hasUpstream: boolean;
  status: McpServerStatus;
  submittedBy: string | null;
} | null> {
  const [item] = await db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.identifier, identifier))
    .limit(1);
  if (!item) {
    return null;
  }
  const versions = await db
    .select({
      origin: mcpServerVersions.origin,
      provenanceJson: mcpServerVersions.provenanceJson,
    })
    .from(mcpServerVersions)
    .where(eq(mcpServerVersions.serverId, item.id));
  const hasUpstream = versions.some((version) => version.origin === "upstream");
  const submittedBy =
    versions
      .map((version) => version.provenanceJson?.submittedBy)
      .find((value): value is string => typeof value === "string") ?? null;
  return { hasUpstream, status: item.status, submittedBy };
}

/** What federation stored for one version about its endpoint. */
export type StoredEndpointProbes = {
  /** `provenanceJson.authProbe`. */
  authProbe?: unknown;
  /** `provenanceJson.toolsListing`. */
  toolsListing?: unknown;
  /** `manifestJson.tools`, the listing's tools. */
  tools?: unknown;
};

/**
 * The endpoint auth probes and tool listings federation stored for these
 * versions, by version id. Versions with neither are absent.
 */
export async function findStoredEndpointProbes(
  versionIds: string[],
): Promise<Map<string, StoredEndpointProbes>> {
  if (versionIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      id: mcpServerVersions.id,
      authProbe: sql<unknown>`${mcpServerVersions.provenanceJson} -> 'authProbe'`,
      toolsListing: sql<unknown>`${mcpServerVersions.provenanceJson} -> 'toolsListing'`,
      // Only versions with a listing carry tools worth reading back.
      tools: sql<unknown>`case when ${mcpServerVersions.provenanceJson} ? 'toolsListing' then ${mcpServerVersions.manifestJson} -> 'tools' end`,
    })
    .from(mcpServerVersions)
    .where(inArray(mcpServerVersions.id, versionIds));
  return new Map(
    rows.flatMap((row) =>
      row.authProbe == null && row.toolsListing == null
        ? []
        : [
            [
              row.id,
              {
                authProbe: row.authProbe ?? undefined,
                toolsListing: row.toolsListing ?? undefined,
                tools: row.tools ?? undefined,
              },
            ] as const,
          ],
    ),
  );
}

/**
 * Shared upsert for a market MCP item + version + categories. Both the
 * submission path (a parsed GitHub repo) and the federation path (an upstream
 * registry entry) call this; they differ only in origin/source/owner and the
 * provenance blob.
 */
export async function upsertMarketMcp(input: {
  manifest: MarketMcpManifest;
  status: McpServerStatus;
  visibility: McpServerVisibility;
  origin: "upstream" | "submitted";
  source?: string | null;
  owner?: string | null;
  provenanceJson?: Record<string, unknown>;
}) {
  const { manifest } = input;
  // A submission must never confer official/verified — those come only from a
  // trusted upstream (federation) or an admin, never from the submitted repo's
  // own manifest content.
  const metadataJson =
    input.origin === "submitted"
      ? { ...metadataFromManifest(manifest), official: false, verified: false }
      : metadataFromManifest(manifest);
  const itemId = mcpServerId(manifest.identifier);
  const versionId = mcpServerVersionId(manifest.identifier, manifest.version);
  const now = new Date();
  const publishedAt = input.status === "published" ? now : null;
  const owner = input.owner ?? null;
  const provenanceJson = input.provenanceJson ?? {};
  const facets = facetsFromMetadata(metadataJson);

  const [server] = await db
    .insert(mcpServers)
    .values({
      id: itemId,
      identifier: manifest.identifier,
      name: manifest.name,
      summary: manifest.summary,
      description: manifest.description ?? manifest.summary,
      status: input.status,
      visibility: input.visibility,
      owner,
      sourceUrl: manifest.sourceUrl,
      repoUrl: manifest.repoUrl,
      metadataJson,
      transport: facets.transport,
      official: facets.official,
      verified: facets.verified,
      desktopOnly: facets.desktopOnly,
      runtime: facets.runtime,
      publishedAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: mcpServers.identifier,
      set: {
        name: manifest.name,
        summary: manifest.summary,
        description: manifest.description ?? manifest.summary,
        status: input.status,
        visibility: input.visibility,
        owner,
        sourceUrl: manifest.sourceUrl,
        repoUrl: manifest.repoUrl,
        metadataJson,
        transport: facets.transport,
        official: facets.official,
        verified: facets.verified,
        desktopOnly: facets.desktopOnly,
        runtime: facets.runtime,
        // updated_at is what the page shows as "Updated" and the floor of the
        // sitemap's lastmod, so a federation run that changes nothing must not
        // move it. lastIndexedAt is excluded because every sync restamps it.
        updatedAt: sql`case when (
          ${mcpServers.name}, ${mcpServers.summary}, ${mcpServers.description},
          ${mcpServers.status}, ${mcpServers.visibility}, ${mcpServers.owner},
          ${mcpServers.sourceUrl}, ${mcpServers.repoUrl},
          ${mcpServers.metadataJson} - 'lastIndexedAt',
          ${mcpServers.transport}, ${mcpServers.official}, ${mcpServers.verified},
          ${mcpServers.desktopOnly}, ${mcpServers.runtime}
        ) is distinct from (
          excluded.name, excluded.summary, excluded.description,
          excluded.status, excluded.visibility, excluded.owner,
          excluded.source_url, excluded.repo_url,
          excluded.metadata_json - 'lastIndexedAt',
          excluded.transport, excluded.official, excluded.verified,
          excluded.desktop_only, excluded.runtime
        ) then excluded.updated_at else ${mcpServers.updatedAt} end`,
        // Keep the FIRST publish time on re-upsert. Stamping now() each
        // federation run turned the catalog's primary sort key into a
        // sync-touch time and broke every in-flight keyset pagination on every
        // scheduled sync (rows jumped ahead of open cursors). Only a
        // null->published transition sets it.
        publishedAt: sql`coalesce(${mcpServers.publishedAt}, excluded.published_at)`,
      },
    })
    .returning({ categoriesSetBy: mcpServers.categoriesSetBy });
  if (!server) {
    throw new Error(
      `MCP catalog upsert returned no row for ${manifest.identifier}`,
    );
  }

  // The README columns (`readme_md`, `readme_*`) are deliberately absent from
  // both the insert and the conflict update: a new version starts `pending`
  // and due by the column defaults, and is then filled from the previous
  // version's README when there is one (it stays due, so the next batch reads
  // it fresh). A re-sync never clears or rewrites a README the fetch job (or
  // a submission) stored.
  const [version] = await db
    .insert(mcpServerVersions)
    .values({
      id: versionId,
      serverId: itemId,
      version: manifest.version,
      status: input.status,
      origin: input.origin,
      source: input.source ?? null,
      manifestJson: manifest,
      provenanceJson,
      publishedAt,
    })
    .onConflictDoUpdate({
      target: [mcpServerVersions.serverId, mcpServerVersions.version],
      set: {
        status: input.status,
        origin: input.origin,
        source: input.source ?? null,
        manifestJson: manifest,
        provenanceJson,
        // Same first-publish preservation as the item row.
        publishedAt: sql`coalesce(${mcpServerVersions.publishedAt}, excluded.published_at)`,
      },
    })
    .returning({ publishedAt: mcpServerVersions.publishedAt });
  // A version going live changes the page even when the row's own fields do
  // not, so it moves updated_at too (below). The upsert keeps the first
  // publication time, so it hands back this run's `now` exactly when this
  // run is the one that published the version (timestamptz keeps the
  // millisecond).
  const versionPublished =
    publishedAt !== null &&
    version?.publishedAt?.getTime() === publishedAt.getTime();
  await carryOverMcpReadme({ serverId: itemId, versionId });

  // Categories follow the manifest only while nobody has chosen them: once the
  // AI overview ('ai') or a market admin ('admin') owns them, a re-sync leaves
  // them alone.
  const categoriesChanged =
    server.categoriesSetBy === "auto" &&
    (await replaceMcpServerCategories(itemId, manifest.categories));

  if (versionPublished || categoriesChanged) {
    await db
      .update(mcpServers)
      .set({ updatedAt: now })
      .where(eq(mcpServers.id, itemId));
  }

  return itemId;
}

/**
 * Sets a server's categories to `slugs`; reports whether the set changed.
 * An unchanged set is only read: federation re-syncs every server, and
 * rewriting identical rows on each run would only churn them.
 */
async function replaceMcpServerCategories(
  serverId: string,
  slugs: readonly string[],
): Promise<boolean> {
  const before = await db
    .select({ categoryId: mcpServerCategories.categoryId })
    .from(mcpServerCategories)
    .where(eq(mcpServerCategories.serverId, serverId));
  const wanted = new Set(slugs.map(mcpCategoryId));
  if (
    before.length === wanted.size &&
    before.every((row) => wanted.has(row.categoryId))
  )
    return false;

  await db
    .delete(mcpServerCategories)
    .where(eq(mcpServerCategories.serverId, serverId));
  const categoryIds = await upsertMcpCategories(db, slugs);
  if (categoryIds.length > 0)
    await db
      .insert(mcpServerCategories)
      .values(categoryIds.map((categoryId) => ({ serverId, categoryId })))
      .onConflictDoNothing({
        target: [mcpServerCategories.serverId, mcpServerCategories.categoryId],
      });
  return true;
}
