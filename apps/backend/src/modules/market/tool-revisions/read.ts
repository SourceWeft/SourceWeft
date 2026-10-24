import { and, desc, eq, lt } from "drizzle-orm";
import { db, marketMcpToolRevisions } from "@sourceweft/db";
import type {
  ListMarketMcpToolRevisionsResponse,
  MarketMcpToolRevision,
  MarketMcpToolRevisionSource,
  MarketMcpToolsRevision,
} from "@sourceweft/market-contracts";
import type { ToolField, ToolRevisionDiff } from "./canonical";

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
 * The source whose tool list the page shows: the owner's while it is visible,
 * otherwise the platform's snapshot, otherwise the members' observation. A
 * source whose latest revision is a withdrawal has no list to show. The owner
 * list counts only when `ownerToolsVisible` (the owner layer shows it), so
 * history never outlives what the page displays.
 */
function displayedSource(
  latest: LatestBySource,
  ownerToolsVisible: boolean,
): MarketMcpToolRevisionSource | null {
  for (const source of SOURCE_PRIORITY) {
    const entry = latest[source];
    if (!entry || entry.withdrawn) continue;
    if (source === "owner" && !ownerToolsVisible) continue;
    return source;
  }
  return null;
}

/** Detail answer: the current revision of the displayed source, or null. */
export async function readToolsRevision(
  itemId: string,
  ownerToolsVisible: boolean,
): Promise<MarketMcpToolsRevision | null> {
  const latest = await latestBySource(itemId);
  const source = displayedSource(latest, ownerToolsVisible);
  if (!source) return null;
  const { revision, observedAt, lastConfirmedAt } = latest[source]!;
  return { source, revision, observedAt, lastConfirmedAt };
}

/** One page of a source's history, newest first. */
export async function readToolRevisionsPage(input: {
  itemId: string;
  /** Defaults to the displayed source. */
  source?: MarketMcpToolRevisionSource;
  ownerToolsVisible: boolean;
  limit: number;
  before?: number;
}): Promise<ListMarketMcpToolRevisionsResponse> {
  const latest = await latestBySource(input.itemId);
  const source = input.source ?? displayedSource(latest, input.ownerToolsVisible);
  const newest = source ? latest[source] : undefined;
  // History of an owner list the page no longer shows is not public.
  if (!source || !newest || (source === "owner" && !input.ownerToolsVisible)) {
    return { source: input.source ?? null, items: [], nextBefore: null };
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
      observedAt: row.observedAt.toISOString(),
      lastConfirmedAt: row.lastConfirmedAt.toISOString(),
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
