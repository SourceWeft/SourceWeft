import {
  mcpTransportSchema,
  type MarketItemSummary,
  type MarketItemVersion,
  type McpRuntime,
  type McpTransport,
} from "@sourceweft/market-contracts";
import { and, desc, eq, ilike, inArray, or } from "drizzle-orm";
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
      return (
        item.name.toLowerCase().includes(query) ||
        item.summary.toLowerCase().includes(query) ||
        item.identifier.toLowerCase().includes(query)
      );
    })
    .slice(0, limit);

  return { items, nextCursor: null };
}

function fallbackFindMcp(identifier: string) {
  return records.find((record) => record.item.identifier === identifier) ?? null;
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

// The metadata-derived facets (transport/official/verified/runtime/desktop) live
// in JSON, so they are filtered in memory. We therefore scan published rows up
// to this cap, filter, then paginate — applying the limit last so filtered
// facets can't silently drop matches. The catalog is small; if it ever exceeds
// this, the omission is logged rather than hidden.
const MAX_LIST_SCAN = 1000;

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

function verificationStatusFor(input: { official: boolean; verified: boolean }) {
  if (input.official) {
    return "official" as const;
  }
  return input.verified ? "verified" : "unverified";
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
    providerName:
      stringMeta(mergedMeta, "providerName") ?? input.row.owner,
    homepageUrl: stringMeta(mergedMeta, "homepageUrl"),
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

function mapVersionRow(row: typeof marketItemVersions.$inferSelect): MarketItemVersion {
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
    .orderBy(desc(marketItemVersions.publishedAt), desc(marketItemVersions.createdAt));

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

function matchesListFilters(
  item: MarketItemSummary,
  input: {
    category?: string;
    transport?: McpTransport;
    official?: boolean;
    verified?: boolean;
    runtime?: McpRuntime;
    includeDesktopOnly?: boolean;
  },
) {
  if (!input.includeDesktopOnly && item.desktopOnly) return false;
  if (input.category && !item.categories.includes(input.category)) return false;
  if (input.transport && item.transport !== input.transport) return false;
  if (typeof input.official === "boolean" && item.official !== input.official) {
    return false;
  }
  if (typeof input.verified === "boolean" && item.verified !== input.verified) {
    return false;
  }
  if (input.runtime && item.runtime !== input.runtime) return false;
  return true;
}

function compareByRecency(a: MarketItemSummary, b: MarketItemSummary) {
  const pa = a.publishedAt ?? "";
  const pb = b.publishedAt ?? "";
  if (pa !== pb) return pa < pb ? 1 : -1; // newest published first, nulls last
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0; // stable tiebreak on id
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

  const dbConditions = [
    eq(marketItems.kind, "mcp" as const),
    eq(marketItems.status, "published" as const),
    eq(marketItems.visibility, "public" as const),
  ];
  if (query) {
    dbConditions.push(
      or(
        ilike(marketItems.name, `%${query}%`),
        ilike(marketItems.summary, `%${query}%`),
        ilike(marketItems.identifier, `%${query}%`),
      )!,
    );
  }

  let dbRows: Array<typeof marketItems.$inferSelect>;
  try {
    dbRows = await db
      .select()
      .from(marketItems)
      .where(and(...dbConditions))
      .limit(MAX_LIST_SCAN + 1);
  } catch (error) {
    if (isDatabaseUnavailable(error)) {
      return fallbackListMcp(input);
    }
    throw error;
  }

  if (dbRows.length > MAX_LIST_SCAN) {
    console.warn(
      `[market] listMcp scan hit cap ${MAX_LIST_SCAN}; some published items were not considered for filtering/pagination`,
    );
    dbRows = dbRows.slice(0, MAX_LIST_SCAN);
  }

  if (dbRows.length === 0) {
    return fallbackListMcp(input);
  }

  const itemIds = dbRows.map((row) => row.id);
  const categoryMap = await categoriesByItemIds(itemIds);
  const latestVersionMap = await latestVersionsByItemIds(itemIds);
  const filtered = dbRows
    .map((row) => {
      const latest = latestVersionMap.get(row.id);
      return mapItemRow({
        row,
        categories: categoryMap.get(row.id) ?? [],
        latestManifestJson: latest?.manifestJson,
        latestVersion: latest?.version ?? null,
      });
    })
    .filter((item) => matchesListFilters(item, input))
    .sort(compareByRecency);

  // Keyset pagination: the cursor is the last id from the previous page.
  let startIndex = 0;
  if (input.cursor) {
    const cursorIndex = filtered.findIndex((item) => item.id === input.cursor);
    startIndex = cursorIndex >= 0 ? cursorIndex + 1 : 0;
  }
  const items = filtered.slice(startIndex, startIndex + limit);
  const nextCursor =
    startIndex + limit < filtered.length
      ? (items[items.length - 1]?.id ?? null)
      : null;
  return { items, nextCursor };
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
    record.versions.find((candidate) => candidate.version === selectedVersion) ??
    null;
  return itemVersion ? { record, itemVersion } : null;
}
