import {
  mcpTransportSchema,
  type MarketItemSummary,
  type MarketItemVersion,
  type McpRuntime,
  type McpTransport,
} from "@sourceweft/market-contracts";
import { and, desc, eq, exists, ilike, inArray, or, sql } from "drizzle-orm";
import {
  db,
  marketCategories,
  marketItemCategories,
  marketItems,
  marketItemVersions,
} from "@sourceweft/db";

type MarketMcpRecord = {
  item: MarketItemSummary;
  versions: MarketItemVersion[];
};

const records: MarketMcpRecord[] = [];

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
  const normalizedIdentifier = sql<string>`regexp_replace(${marketItems.identifier}, '^(io|com)\\.github\\.', '', 'i')`;
  const conditions = [
    ilike(marketItems.name, `%${query}%`),
    ilike(marketItems.summary, `%${query}%`),
    ilike(normalizedIdentifier, `%${query}%`),
  ];
  if (queryIncludesTechnicalIdentifierSyntax(query)) {
    conditions.push(ilike(marketItems.identifier, `%${query}%`));
  }
  return or(...conditions)!;
}

function fallbackListMcp(input: {
  query?: string;
  category?: string;
  transport?: McpTransport;
  official?: boolean;
  verified?: boolean;
  runtime?: McpRuntime;
  includeDesktopOnly?: boolean;
  limit?: number;
}) {
  const query = input.query?.trim().toLowerCase();
  const limit = input.limit ?? 50;
  const items = records
    .map((record) => record.item)
    .filter((item) => item.status === "published")
    .filter((item) => input.includeDesktopOnly || !item.desktopOnly)
    .filter((item) =>
      input.category ? item.categories.includes(input.category) : true,
    )
    .filter((item) =>
      input.transport ? item.transport === input.transport : true,
    )
    .filter((item) =>
      typeof input.official === "boolean"
        ? item.official === input.official
        : true,
    )
    .filter((item) =>
      typeof input.verified === "boolean"
        ? item.verified === input.verified
        : true,
    )
    .filter((item) => (input.runtime ? item.runtime === input.runtime : true))
    .filter((item) => {
      if (!query) {
        return true;
      }
      const searchableIdentifier = identifierForSearch(item.identifier);
      return (
        item.name.toLowerCase().includes(query) ||
        item.summary.toLowerCase().includes(query) ||
        searchableIdentifier.includes(query) ||
        (queryIncludesTechnicalIdentifierSyntax(query) &&
          item.identifier.toLowerCase().includes(query))
      );
    })
    .slice(0, limit);

  return { items, nextCursor: null };
}

function fallbackFindMcp(identifier: string) {
  return (
    records.find((record) => record.item.identifier === identifier) ?? null
  );
}

// Only genuine connectivity failures should fall back to the (empty) static
// list. Query errors — bad SQL, constraint violations, serialization failures —
// must propagate so the caller returns a 500 instead of masking a bug as an
// empty catalog.
const DB_CONNECTION_ERROR_CODES = new Set([
  "econnrefused",
  "econnreset",
  "etimedout",
  "enotfound",
  "epipe",
  "08000", // connection_exception
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "08006", // connection_failure
  "57p01", // admin_shutdown
  "57p03", // cannot_connect_now
]);

function isDatabaseUnavailable(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: string }).code?.toLowerCase();
  if (code && DB_CONNECTION_ERROR_CODES.has(code)) {
    return true;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("econnrefused") ||
    message.includes("connection terminated") ||
    message.includes("connection refused") ||
    message.includes("could not connect") ||
    message.includes("connect etimedout") ||
    message.includes("the database system is")
  );
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
  const toolsCount = value?.toolsCount;
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

// The upstream registry ships an icon for only a small fraction of entries, so
// most cards fall back to the generic glyph. Nearly every entry is GitHub-hosted
// (io.github.<owner>/<repo>), so derive the owner's avatar as a real logo when no
// upstream icon exists. The <img> follows github.com's redirect to the avatar CDN
// and the client falls back to the glyph on load error, so a wrong guess is safe.
function githubOwner(repoUrl: string | null, identifier: string): string | null {
  if (repoUrl) {
    try {
      const url = new URL(repoUrl);
      if (url.hostname === "github.com" || url.hostname.endsWith(".github.com")) {
        const owner = url.pathname.split("/").filter(Boolean)[0];
        if (owner) {
          return owner;
        }
      }
    } catch {
      // Fall through to the identifier-based derivation below.
    }
  }
  const namespace = identifier.split("/")[0] ?? "";
  const match = namespace.match(/^io\.github\.(.+)$/i);
  return match?.[1] ?? null;
}

function deriveIconUrl(input: {
  repoUrl: string | null;
  identifier: string;
}): string | null {
  const owner = githubOwner(input.repoUrl, input.identifier);
  return owner
    ? `https://github.com/${encodeURIComponent(owner)}.png?size=80`
    : null;
}

function mapItemRow(input: {
  row: typeof marketItems.$inferSelect;
  categories: string[];
  latestVersion?: string | null;
  latestManifestJson?: Record<string, unknown> | null;
}): MarketItemSummary {
  const mergedMeta = mergeMetaSources(
    input.row.metadataJson,
    input.latestManifestJson,
  );
  const meta = toManifestMeta(mergedMeta);
  return {
    id: input.row.id,
    kind: input.row.kind,
    identifier: input.row.identifier,
    name: input.row.name,
    summary: input.row.summary,
    providerName: stringMeta(mergedMeta, "providerName") ?? input.row.owner,
    homepageUrl: stringMeta(mergedMeta, "homepageUrl"),
    iconUrl:
      stringMeta(mergedMeta, "iconUrl") ??
      deriveIconUrl({
        repoUrl: input.row.repoUrl,
        identifier: input.row.identifier,
      }),
    sourceUrl: input.row.sourceUrl,
    repoUrl: input.row.repoUrl,
    license: stringMeta(mergedMeta, "license"),
    language: stringMeta(mergedMeta, "language"),
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
    lastIndexedAt: stringMeta(mergedMeta, "lastIndexedAt"),
    createdAt: input.row.createdAt.toISOString(),
    updatedAt: input.row.updatedAt.toISOString(),
    publishedAt: iso(input.row.publishedAt),
  };
}

function mapVersionRow(
  row: typeof marketItemVersions.$inferSelect,
): MarketItemVersion {
  return {
    version: row.version,
    status: row.status,
    manifestJson: row.manifestJson,
    packageSha256: row.packageSha256,
    // Signing was removed from the market pipeline; the versions table no longer
    // carries signature/signingKeyId columns. The wire contract still declares
    // these nullable fields, so surface them as null.
    signature: null,
    signingKeyId: null,
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
      itemId: marketItemCategories.itemId,
      slug: marketCategories.slug,
    })
    .from(marketItemCategories)
    .innerJoin(
      marketCategories,
      eq(marketCategories.id, marketItemCategories.categoryId),
    )
    .where(inArray(marketItemCategories.itemId, itemIds));

  const map = new Map<string, string[]>();
  for (const row of rows) {
    const existing = map.get(row.itemId) ?? [];
    existing.push(row.slug);
    map.set(row.itemId, existing);
  }
  return map;
}

async function latestVersionsByItemIds(itemIds: string[]) {
  if (itemIds.length === 0) {
    return new Map<
      string,
      { manifestJson: Record<string, unknown>; version: string }
    >();
  }
  const rows = await db
    .select()
    .from(marketItemVersions)
    .where(
      and(
        inArray(marketItemVersions.itemId, itemIds),
        eq(marketItemVersions.status, "published"),
      ),
    )
    // Deterministic "latest": newest published first, so the first row we keep
    // per item is stable rather than whatever order Postgres returns.
    .orderBy(
      desc(marketItemVersions.publishedAt),
      desc(marketItemVersions.createdAt),
    );

  const map = new Map<
    string,
    { manifestJson: Record<string, unknown>; version: string }
  >();
  for (const row of rows) {
    if (!map.has(row.itemId)) {
      map.set(row.itemId, {
        manifestJson: row.manifestJson,
        version: row.version,
      });
    }
  }
  return map;
}

// Keyset cursor over the (publishedAt desc, id desc) ordering. Opaque to
// callers; encodes the last row of the previous page so the next page is a plain
// indexed range scan rather than an offset that grows with the catalog.
function encodeListCursor(publishedAt: Date | null, id: string): string {
  const millis = publishedAt ? publishedAt.getTime() : 0;
  return Buffer.from(`${millis}|${id}`).toString("base64url");
}

function decodeListCursor(
  cursor: string | undefined,
): { publishedAt: Date; id: string } | null {
  if (!cursor) {
    return null;
  }
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const separator = decoded.indexOf("|");
    if (separator < 0) {
      return null;
    }
    const millis = Number(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    // Beyond ±8.64e15 ms, new Date() is an Invalid Date, which the pg driver
    // serializes into a literal Postgres rejects — a crafted cursor 500. Treat
    // out-of-range like malformed base64: fall back to page one.
    if (!Number.isFinite(millis) || Math.abs(millis) > 8.64e15 || !id) {
      return null;
    }
    return { publishedAt: new Date(millis), id };
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
  limit?: number;
  cursor?: string;
}) {
  const query = input.query?.trim().toLowerCase();
  const limit = Math.max(1, Math.min(input.limit ?? 50, 100));

  // Everything is pushed into SQL — facets are real columns and categories join
  // — so the whole catalog is filtered/ordered/paginated in the database. No
  // in-memory scan cap, so results are complete at any catalog size.
  const conditions = [
    eq(marketItems.kind, "mcp" as const),
    eq(marketItems.status, "published" as const),
    eq(marketItems.visibility, "public" as const),
  ];
  if (query) {
    conditions.push(marketSearchCondition(query));
  }
  if (!input.includeDesktopOnly) {
    conditions.push(eq(marketItems.desktopOnly, false));
  }
  if (input.transport) {
    conditions.push(eq(marketItems.transport, input.transport));
  }
  if (typeof input.official === "boolean") {
    conditions.push(eq(marketItems.official, input.official));
  }
  if (typeof input.verified === "boolean") {
    conditions.push(eq(marketItems.verified, input.verified));
  }
  if (input.runtime) {
    conditions.push(eq(marketItems.runtime, input.runtime));
  }
  if (input.category) {
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(marketItemCategories)
          .innerJoin(
            marketCategories,
            eq(marketCategories.id, marketItemCategories.categoryId),
          )
          .where(
            and(
              eq(marketItemCategories.itemId, marketItems.id),
              eq(marketCategories.slug, input.category),
            ),
          ),
      ),
    );
  }
  const cursor = decodeListCursor(input.cursor);
  if (cursor) {
    // Next page in the (publishedAt desc, id desc) ordering: rows strictly after
    // the cursor row, via a row-value comparison the browse index can serve.
    conditions.push(
      sql`(${marketItems.publishedAt}, ${marketItems.id}) < (${cursor.publishedAt}, ${cursor.id})`,
    );
  }

  let dbRows: Array<typeof marketItems.$inferSelect>;
  try {
    dbRows = await db
      .select()
      .from(marketItems)
      .where(and(...conditions))
      .orderBy(desc(marketItems.publishedAt), desc(marketItems.id))
      .limit(limit + 1);
  } catch (error) {
    if (isDatabaseUnavailable(error)) {
      return fallbackListMcp(input);
    }
    throw error;
  }

  const hasMore = dbRows.length > limit;
  const pageRows = hasMore ? dbRows.slice(0, limit) : dbRows;
  const itemIds = pageRows.map((row) => row.id);
  const categoryMap = await categoriesByItemIds(itemIds);
  const latestVersionMap = await latestVersionsByItemIds(itemIds);
  const items = pageRows.map((row) => {
    const latest = latestVersionMap.get(row.id);
    return mapItemRow({
      row,
      categories: categoryMap.get(row.id) ?? [],
      latestManifestJson: latest?.manifestJson,
      latestVersion: latest?.version ?? null,
    });
  });
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last ? encodeListCursor(last.publishedAt, last.id) : null;
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
}): Promise<{ counts: Record<string, number>; total: number }> {
  const query = input.query?.trim().toLowerCase();
  const conditions = [
    eq(marketItems.kind, "mcp" as const),
    eq(marketItems.status, "published" as const),
    eq(marketItems.visibility, "public" as const),
  ];
  if (query) {
    conditions.push(marketSearchCondition(query));
  }
  if (!input.includeDesktopOnly) {
    conditions.push(eq(marketItems.desktopOnly, false));
  }

  try {
    const [categoryRows, totalRows] = await Promise.all([
      db
        .select({
          slug: marketCategories.slug,
          count: sql<number>`count(distinct ${marketItems.id})::int`,
        })
        .from(marketItems)
        .innerJoin(
          marketItemCategories,
          eq(marketItemCategories.itemId, marketItems.id),
        )
        .innerJoin(
          marketCategories,
          eq(marketCategories.id, marketItemCategories.categoryId),
        )
        .where(and(...conditions))
        .groupBy(marketCategories.slug),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(marketItems)
        .where(and(...conditions)),
    ]);
    const counts: Record<string, number> = {};
    for (const row of categoryRows) {
      counts[row.slug] = Number(row.count);
    }
    return { counts, total: Number(totalRows[0]?.count ?? 0) };
  } catch (error) {
    if (isDatabaseUnavailable(error)) {
      return { counts: {}, total: 0 };
    }
    throw error;
  }
}

export async function findMcp(identifier: string) {
  let row: typeof marketItems.$inferSelect | undefined;
  try {
    [row] = await db
      .select()
      .from(marketItems)
      .where(
        and(
          eq(marketItems.kind, "mcp"),
          eq(marketItems.identifier, identifier),
          eq(marketItems.status, "published"),
          eq(marketItems.visibility, "public"),
        ),
      )
      .limit(1);
  } catch (error) {
    if (isDatabaseUnavailable(error)) {
      return fallbackFindMcp(identifier);
    }
    throw error;
  }
  if (row) {
    // Only ever expose published versions on the public API. Loading drafts
    // here would let a consumer install an unpublished version by naming it,
    // and would leak its manifest. Newest published first.
    const versions = await db
      .select()
      .from(marketItemVersions)
      .where(
        and(
          eq(marketItemVersions.itemId, row.id),
          eq(marketItemVersions.status, "published"),
        ),
      )
      .orderBy(
        desc(marketItemVersions.publishedAt),
        desc(marketItemVersions.createdAt),
      );
    const categoryMap = await categoriesByItemIds([row.id]);
    const latest = versions[0];
    return {
      item: mapItemRow({
        row,
        categories: categoryMap.get(row.id) ?? [],
        latestManifestJson: latest?.manifestJson,
        latestVersion: latest?.version ?? null,
      }),
      versions: versions.map(mapVersionRow),
    };
  }
  return fallbackFindMcp(identifier);
}

export async function findMcpVersion(identifier: string, version?: string) {
  const record = await findMcp(identifier);
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
