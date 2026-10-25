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
 * The source whose tool list the page shows. While the owner layer shows an
 * owner list, the owner is the ONLY candidate: with no revision of its own yet
 * (every list stored before revisions existed) there is no history to show,
 * never another source's. Otherwise the platform's snapshot, then the members'
 * observation. A source whose latest revision is a withdrawal has no list.
 */
function displayedSource(
  latest: LatestBySource,
  ownerToolsVisible: boolean,
): MarketMcpToolRevisionSource | null {
  if (ownerToolsVisible) {
    const owner = latest.owner;
    return owner && !owner.withdrawn ? "owner" : null;
  }
  for (const source of SOURCE_PRIORITY) {
    if (source === "owner") continue;
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
): Promise<MarketMcpToolsRevision | null> {
  const latest = await latestBySource(itemId);
  const source = displayedSource(latest, ownerToolsVisible);
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
  limit: number;
  before?: number;
}): Promise<ListMarketMcpToolRevisionsResponse> {
  const latest = await latestBySource(input.itemId);
  const source = displayedSource(latest, input.ownerToolsVisible);
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
