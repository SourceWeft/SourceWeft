import { eq, sql } from "drizzle-orm";
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
import { hashId } from "./plan";

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
    .select()
    .from(mcpServerVersions)
    .where(eq(mcpServerVersions.serverId, item.id));
  const hasUpstream = versions.some((version) => version.origin === "upstream");
  const submittedBy =
    versions
      .map((version) => version.provenanceJson?.submittedBy)
      .find((value): value is string => typeof value === "string") ?? null;
  return { hasUpstream, status: item.status, submittedBy };
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
  const itemId = hashId("mcp", manifest.identifier);
  const versionId = hashId(
    "mcpv",
    `${manifest.identifier}@${manifest.version}`,
  );
  const now = new Date();
  const publishedAt = input.status === "published" ? now : null;
  const owner = input.owner ?? null;
  const provenanceJson = input.provenanceJson ?? {};
  const facets = facetsFromMetadata(metadataJson);

  await db
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
        updatedAt: now,
        // Keep the FIRST publish time on re-upsert. Stamping now() each
        // federation run turned the catalog's primary sort key into a
        // sync-touch time and broke every in-flight keyset pagination on every
        // scheduled sync (rows jumped ahead of open cursors). Only a
        // null->published transition sets it.
        publishedAt: sql`coalesce(${mcpServers.publishedAt}, excluded.published_at)`,
      },
    });

  await db
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
    });

  await db
    .delete(mcpServerCategories)
    .where(eq(mcpServerCategories.serverId, itemId));

  for (const slug of manifest.categories) {
    const categoryId = hashId("mcp-cat", slug);
    await db
      .insert(mcpCategories)
      .values({
        id: categoryId,
        slug,
        name: categoryName(slug),
        description: categoryDescription(slug),
      })
      .onConflictDoUpdate({
        target: mcpCategories.slug,
        set: {
          name: categoryName(slug),
          description: categoryDescription(slug),
        },
      });
    await db
      .insert(mcpServerCategories)
      .values({ serverId: itemId, categoryId })
      .onConflictDoNothing({
        target: [mcpServerCategories.serverId, mcpServerCategories.categoryId],
      });
  }

  return itemId;
}
