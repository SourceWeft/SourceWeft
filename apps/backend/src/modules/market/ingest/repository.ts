import { eq } from "drizzle-orm";
import type { MarketMcpManifest } from "@sourceweft/market-contracts";
import {
  db,
  marketCategories,
  marketItemCategories,
  marketItems,
  marketItemVersions,
} from "@sourceweft/db";
import type {
  McpParserReport,
  McpRepositoryIngestOptions,
} from "../types";
import { getMcpCategoryDefinition } from "../parser/categories";
import { buildDryRunIngestResult, hashId } from "./plan";

export { buildDryRunIngestResult } from "./plan";

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
    license: manifest.license,
    language: manifest.language,
    toolsCount: manifest.tools.length,
    lastIndexedAt: manifest.lastIndexedAt ?? new Date().toISOString(),
  };
}

type MarketItemStatus = McpRepositoryIngestOptions["status"];
type MarketItemVisibility = McpRepositoryIngestOptions["visibility"];

/**
 * Shared upsert for a market MCP item + version + categories. Both the
 * submission path (a parsed GitHub repo) and the federation path (an upstream
 * registry entry) call this; they differ only in origin/source/owner and the
 * provenance blob.
 */
export async function upsertMarketMcp(input: {
  manifest: MarketMcpManifest;
  status: MarketItemStatus;
  visibility: MarketItemVisibility;
  origin: "upstream" | "submitted";
  source?: string | null;
  owner?: string | null;
  provenanceJson?: Record<string, unknown>;
}) {
  const { manifest } = input;
  const itemId = hashId("mcp", manifest.identifier);
  const versionId = hashId("mcpv", `${manifest.identifier}@${manifest.version}`);
  const now = new Date();
  const publishedAt = input.status === "published" ? now : null;
  const owner = input.owner ?? null;
  const provenanceJson = input.provenanceJson ?? {};

  await db
    .insert(marketItems)
    .values({
      id: itemId,
      kind: "mcp",
      identifier: manifest.identifier,
      name: manifest.name,
      summary: manifest.summary,
      description: manifest.description ?? manifest.summary,
      status: input.status,
      visibility: input.visibility,
      owner,
      sourceUrl: manifest.sourceUrl,
      repoUrl: manifest.repoUrl,
      metadataJson: metadataFromManifest(manifest),
      publishedAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: marketItems.identifier,
      set: {
        name: manifest.name,
        summary: manifest.summary,
        description: manifest.description ?? manifest.summary,
        status: input.status,
        visibility: input.visibility,
        owner,
        sourceUrl: manifest.sourceUrl,
        repoUrl: manifest.repoUrl,
        metadataJson: metadataFromManifest(manifest),
        updatedAt: now,
        publishedAt,
      },
    });

  await db
    .insert(marketItemVersions)
    .values({
      id: versionId,
      itemId,
      version: manifest.version,
      status: input.status,
      origin: input.origin,
      source: input.source ?? null,
      manifestJson: manifest,
      readmeMd: undefined,
      provenanceJson,
      publishedAt,
    })
    .onConflictDoUpdate({
      target: [marketItemVersions.itemId, marketItemVersions.version],
      set: {
        status: input.status,
        origin: input.origin,
        source: input.source ?? null,
        manifestJson: manifest,
        provenanceJson,
        publishedAt,
      },
    });

  await db
    .delete(marketItemCategories)
    .where(eq(marketItemCategories.itemId, itemId));

  for (const slug of manifest.categories) {
    const categoryId = hashId("mcp-cat", slug);
    await db
      .insert(marketCategories)
      .values({
        id: categoryId,
        slug,
        name: categoryName(slug),
        description: categoryDescription(slug),
      })
      .onConflictDoUpdate({
        target: marketCategories.slug,
        set: {
          name: categoryName(slug),
          description: categoryDescription(slug),
        },
      });
    await db
      .insert(marketItemCategories)
      .values({ itemId, categoryId })
      .onConflictDoNothing({
        target: [marketItemCategories.itemId, marketItemCategories.categoryId],
      });
  }

  return itemId;
}

export async function upsertMcpIngestResult(
  manifest: MarketMcpManifest,
  provenanceJson: McpParserReport,
  options: McpRepositoryIngestOptions,
) {
  await upsertMarketMcp({
    manifest,
    status: options.status,
    visibility: options.visibility,
    origin: "submitted",
    owner: provenanceJson.github.owner,
    provenanceJson,
  });
  return buildDryRunIngestResult(manifest, provenanceJson, options);
}
