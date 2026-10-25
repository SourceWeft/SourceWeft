import { and, desc, eq, lt } from "drizzle-orm";
import { db, marketMcpToolRevisions } from "@sourceweft/db";
import {
  MARKET_MCP_TOOL_SOURCE_MEMBER_OBSERVED,
  MARKET_MCP_TOOL_SOURCE_PLATFORM_INDEXED,
  marketMcpInspectedToolSchema,
  marketMcpReferenceProfileSchema,
  type ListMarketMcpToolRevisionsResponse,
  type MarketMcpToolManifest,
  type MarketMcpToolRevision,
  type MarketMcpToolRevisionSource,
  type MarketMcpToolsReference,
  type MarketMcpToolsRevision,
} from "@sourceweft/market-contracts";
import type { ToolField, ToolRevisionDiff } from "./canonical";
import { endpointKeyHash, pinEndpoint } from "./endpoint-pin";

/**
 * Reads of the tool-revision history, for the detail answer and the public
 * change log. Only the diff summary is returned, never the stored lists.
 */

/** Which source the page shows, highest first. */
const SOURCE_PRIORITY: readonly MarketMcpToolRevisionSource[] = [
  "owner",
  "platform-indexed",
  "member-observed",
];

type LatestBySource = Partial<
  Record<MarketMcpToolRevisionSource, MarketMcpToolsRevision & { withdrawn: boolean }>
>;

async function latestBySource(itemId: string): Promise<LatestBySource> {
  const rows = await db
    .selectDistinctOn([marketMcpToolRevisions.source], {
      source: marketMcpToolRevisions.source,
      revision: marketMcpToolRevisions.revision,
      withdrawn: marketMcpToolRevisions.withdrawn,
      observedAt: marketMcpToolRevisions.observedAt,
      lastConfirmedAt: marketMcpToolRevisions.lastConfirmedAt,
    })
    .from(marketMcpToolRevisions)
    .where(eq(marketMcpToolRevisions.itemId, itemId))
    .orderBy(marketMcpToolRevisions.source, desc(marketMcpToolRevisions.revision));
  const out: LatestBySource = {};
  for (const row of rows) {
    out[row.source] = {
      source: row.source,
      revision: row.revision,
      withdrawn: row.withdrawn,
      observedAt: row.observedAt.toISOString(),
      lastConfirmedAt: row.lastConfirmedAt.toISOString(),
    };
  }
  return out;
}

/**
 * The source whose tool list the page shows. While the owner layer shows an
 * owner list, the owner is the ONLY candidate: with no revision of its own yet
 * (every list stored before revisions existed) there is no history to show,
 * never another source's. Otherwise the platform's snapshot, then the members'
 * observation. A source whose latest revision is a withdrawal has no list.
 */
function displayedSource(
  latest: LatestBySource,
  ownerToolsVisible: boolean,
  baseToolsListed: boolean,
): MarketMcpToolRevisionSource | null {
  if (ownerToolsVisible) {
    const owner = latest.owner;
    return owner && !owner.withdrawn ? "owner" : null;
  }
  for (const source of SOURCE_PRIORITY) {
    if (source === "owner") continue;
    // The registry's or a probe's own list is the server's word, listed
    // without anyone's account; members' observations never replace it.
    if (source === "member-observed" && baseToolsListed) continue;
    const entry = latest[source];
    if (entry && !entry.withdrawn) return source;
  }
  return null;
}

/**
 * What the public may learn of when. Each member connection can refresh a
 * `member-observed` revision, so its times are coarsened to the day: they would
 * otherwise say when anyone last connected.
 */
function publicTime(source: MarketMcpToolRevisionSource, at: Date): string {
  const iso = at.toISOString();
  return source === "member-observed" ? `${iso.slice(0, 10)}T00:00:00.000Z` : iso;
}

/** Detail answer: the current revision of the displayed source, or null. */
export async function readToolsRevision(
  itemId: string,
  ownerToolsVisible: boolean,
  baseToolsListed = false,
): Promise<MarketMcpToolsRevision | null> {
  const latest = await latestBySource(itemId);
  const source = displayedSource(latest, ownerToolsVisible, baseToolsListed);
  if (!source) return null;
  const { revision, observedAt, lastConfirmedAt } = latest[source]!;
  return {
    source,
    revision,
    observedAt: publicTime(source, new Date(observedAt)),
    lastConfirmedAt: publicTime(source, new Date(lastConfirmedAt)),
  };
}

/**
 * One page of the DISPLAYED source's history, newest first. There is no way to
 * ask for another source: the history of a list the page does not show (a
 * lower-priority source, a withdrawn one) is not public.
 */
export async function readToolRevisionsPage(input: {
  itemId: string;
  ownerToolsVisible: boolean;
  /** The registry or a probe listed tools: members' observations stay hidden. */
  baseToolsListed?: boolean;
  limit: number;
  before?: number;
}): Promise<ListMarketMcpToolRevisionsResponse> {
  const latest = await latestBySource(input.itemId);
  const source = displayedSource(
    latest,
    input.ownerToolsVisible,
    input.baseToolsListed ?? false,
  );
  const newest = source ? latest[source] : undefined;
  if (!source || !newest) {
    return { source: null, items: [], nextBefore: null };
  }
  const rows = await db
    .select({
      revision: marketMcpToolRevisions.revision,
      withdrawn: marketMcpToolRevisions.withdrawn,
      toolsCount: marketMcpToolRevisions.toolsCount,
      serverVersion: marketMcpToolRevisions.serverVersion,
      observedAt: marketMcpToolRevisions.observedAt,
      lastConfirmedAt: marketMcpToolRevisions.lastConfirmedAt,
      diffJson: marketMcpToolRevisions.diffJson,
    })
    .from(marketMcpToolRevisions)
    .where(
      and(
        eq(marketMcpToolRevisions.itemId, input.itemId),
        eq(marketMcpToolRevisions.source, source),
        input.before === undefined
          ? undefined
          : lt(marketMcpToolRevisions.revision, input.before),
      ),
    )
    .orderBy(desc(marketMcpToolRevisions.revision))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const items: MarketMcpToolRevision[] = page.map((row) => {
    const diff = row.diffJson as Partial<ToolRevisionDiff>;
    return {
      source,
      revision: row.revision,
      current: row.revision === newest.revision && !row.withdrawn,
      withdrawn: row.withdrawn,
      toolsCount: row.toolsCount,
      serverVersion: row.serverVersion,
      observedAt: publicTime(source, row.observedAt),
      lastConfirmedAt: publicTime(source, row.lastConfirmedAt),
      added: diff.added ?? [],
      removed: diff.removed ?? [],
      changed: (diff.changed ?? []).map((entry) => ({
        name: entry.name,
        fields: entry.fields as ToolField[],
      })),
    };
  });
  return {
    source,
    items,
    nextBefore:
      rows.length > input.limit ? page[page.length - 1]!.revision : null,
  };
}

export type ReferenceTools = {
  tools: MarketMcpToolManifest[];
  reference: Omit<MarketMcpToolsReference, "stale">;
  /** sha256 of the pinned endpoint the list was read from. */
  endpointKey: string | null;
};

/**
 * The tools of the displayed non-owner source, as manifest tools (risk
 * `unknown`, source marked), or null when the page shows the owner's list or
 * no source has one. Same priority as the history ({@link displayedSource}):
 * the platform's snapshot, then the members' observation, never both.
 * The caller decides `stale` per version, from `endpointKey`.
 */
export async function readReferenceTools(
  itemId: string,
  ownerToolsVisible: boolean,
  baseToolsListed: boolean,
): Promise<ReferenceTools | null> {
  if (ownerToolsVisible) return null;
  const latest = await latestBySource(itemId);
  const source = displayedSource(latest, false, baseToolsListed);
  if (source !== "platform-indexed" && source !== "member-observed") return null;
  const [row] = await db
    .select({
      toolsJson: marketMcpToolRevisions.toolsJson,
      observedAt: marketMcpToolRevisions.observedAt,
      lastConfirmedAt: marketMcpToolRevisions.lastConfirmedAt,
      endpointKey: marketMcpToolRevisions.endpointKey,
      referenceProfileJson: marketMcpToolRevisions.referenceProfileJson,
    })
    .from(marketMcpToolRevisions)
    .where(
      and(
        eq(marketMcpToolRevisions.itemId, itemId),
        eq(marketMcpToolRevisions.source, source),
      ),
    )
    .orderBy(desc(marketMcpToolRevisions.revision))
    .limit(1);
  if (!row || !Array.isArray(row.toolsJson)) return null;
  const tools: MarketMcpToolManifest[] = [];
  const seen = new Set<string>();
  for (const entry of row.toolsJson) {
    const parsed = marketMcpInspectedToolSchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.name)) continue;
    seen.add(parsed.data.name);
    tools.push({
      name: parsed.data.name,
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      ...(parsed.data.description !== undefined
        ? { description: parsed.data.description }
        : {}),
      inputSchema: parsed.data.inputSchema,
      ...(parsed.data.outputSchema !== undefined
        ? { outputSchema: parsed.data.outputSchema }
        : {}),
      annotations: parsed.data.annotations,
      risk: "unknown",
      source:
        source === "platform-indexed"
          ? MARKET_MCP_TOOL_SOURCE_PLATFORM_INDEXED
          : MARKET_MCP_TOOL_SOURCE_MEMBER_OBSERVED,
    });
  }
  // The newest confirmation is the date shown: "read by SourceWeft … · date".
  const profile = marketMcpReferenceProfileSchema.safeParse(row.referenceProfileJson);
  return {
    tools,
    endpointKey: row.endpointKey,
    reference: {
      source,
      observedAt: publicTime(source, row.lastConfirmedAt),
      profile: source === "platform-indexed" && profile.success ? profile.data : null,
    },
  };
}

/**
 * Whether the list was read from an address other than the one `manifest`
 * (a version's manifest) names now. A list with no recorded address is stale
 * too: it cannot be shown to be about this server.
 */
export function referenceIsStale(
  endpointKey: string | null,
  manifestEndpointUrl: unknown,
): boolean {
  if (!endpointKey || typeof manifestEndpointUrl !== "string") return true;
  const pin = pinEndpoint(manifestEndpointUrl);
  return !pin || endpointKeyHash(pin) !== endpointKey;
}

/** Whether a stored manifest lists tools of its own (registry, probe or sandbox). */
export function manifestListsTools(manifestJson: Record<string, unknown> | undefined): boolean {
  const tools = manifestJson?.tools;
  return Array.isArray(tools) && tools.length > 0;
}

/**
 * A version's manifest with the platform's or the members' tool list on top
 * (never over an owner's, which {@link readReferenceTools} leaves out). Marks
 * the list stale when this version's endpoint is no longer the address the
 * list was read from.
 */
export function applyReferenceToolsToManifest(
  manifestJson: Record<string, unknown>,
  reference: ReferenceTools | null,
): Record<string, unknown> {
  if (!reference) return manifestJson;
  return {
    ...manifestJson,
    tools: reference.tools,
    toolsReference: {
      ...reference.reference,
      stale: referenceIsStale(reference.endpointKey, manifestJson.endpointUrl),
    },
  };
}
