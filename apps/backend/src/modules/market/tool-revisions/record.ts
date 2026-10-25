import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, lte, sql } from "drizzle-orm";
import {
  db,
  marketMcpToolRevisions,
  type McpToolRevisionSource,
} from "@sourceweft/db";
import {
  TOOL_CANONICAL_VERSION,
  TOOL_REVISIONS_KEPT_FULL,
  TOOL_REVISIONS_KEPT_ROWS,
  TOOL_REVISIONS_PER_DAY,
  WITHDRAWN_TOOLS_HASH,
  canonicalizeTools,
  diffTools,
  hashCanonicalTools,
  validateTools,
  type CanonicalTool,
  type ToolRevisionDiff,
} from "./canonical";

/**
 * Writes of the tool-revision history (Issue #367). Every source of a
 * listing's tool list — the owner's submission, the platform's own snapshot, a
 * member's authenticated discovery — goes through `recordToolRevision`, so the
 * rules for "is this a new revision" live in one place.
 */

export type { McpToolRevisionSource };

export type ToolRevisionTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type RecordToolRevisionInput = {
  /** The catalog item (`mcp_servers.id`). */
  itemId: string;
  source: McpToolRevisionSource;
  /**
   * The COMPLETE list the source just obtained. Validated with the owner
   * submission limits (200 tools, 2,000-character descriptions, 32 KiB of
   * schemas and annotations per tool); anything over a limit, or a name listed
   * twice, throws `ToolRevisionInputError` — a clipped list is never recorded.
   * An empty list is a valid revision ("this source lists no tools").
   *
   * Callers must NEVER call this for a failed, partial or unknown discovery:
   * "could not list" is not "lists nothing", and nothing is recorded for it.
   */
  tools: readonly unknown[];
  /** What the server called its own version. Context only; not part of the key. */
  serverVersion?: string | null;
  /** When the list was obtained. Defaults to now. */
  observedAt?: Date;
  /**
   * What the list was read from, for the pinned sources (the platform snapshot
   * and a member's observation): the hash of the pinned endpoint, and the
   * platform snapshot's reference profile. Stored with a new revision and
   * moved forward when the same list is confirmed again, so "this list is
   * about the listing's current address" is judged at the latest confirmation.
   */
  endpointKey?: string | null;
  referenceProfile?: Record<string, unknown> | null;
  /**
   * Record nothing while the source's latest revision is a withdrawal (an
   * admin's takedown), decided under the same lock as the write, so a takedown
   * can never be overtaken by a recording that read the state before it.
   */
  skipWhenTakenDown?: boolean;
};

export type ToolRevisionOutcome =
  | {
      /** A new revision was written. */
      outcome: "created";
      revision: number;
      toolsHash: string;
      diff: ToolRevisionDiff;
    }
  | {
      /** The same list as the source's latest revision: only confirmed again. */
      outcome: "confirmed";
      revision: number;
      toolsHash: string;
      diff: null;
    }
  | {
      /**
       * The source already made {@link TOOL_REVISIONS_PER_DAY} revisions in the
       * last 24 hours: nothing was recorded (the caller's own write is
       * unaffected). The next change, once the window has room, is recorded
       * against the latest revision as usual.
       */
      outcome: "throttled";
      revision: null;
      toolsHash: string;
      diff: null;
    }
  | {
      /** `skipWhenTakenDown` was set and the source is taken down. */
      outcome: "taken-down";
      revision: null;
      toolsHash: string;
      diff: null;
    };

export type WithdrawToolRevisionInput = {
  itemId: string;
  source: McpToolRevisionSource;
  observedAt?: Date;
};

export type WithdrawToolRevisionOutcome =
  | { outcome: "withdrawn"; revision: number; diff: ToolRevisionDiff }
  /** The source had no list to take back (never recorded, or already withdrawn). */
  | { outcome: "none" };

type RevisionRow = typeof marketMcpToolRevisions.$inferSelect;

/**
 * Records the source's tool list as the next revision when its canonical form
 * differs from the source's latest revision, otherwise only refreshes that
 * revision's `lastConfirmedAt`.
 *
 * - Canonical form: tools sorted by name, object keys sorted at every depth,
 *   description/title whitespace normalised, array order inside schemas kept
 *   (see ./canonical.ts). Formatting-only changes therefore never create a
 *   revision.
 * - The diff is by tool name: added, removed, and changed with which of
 *   title / description / inputSchema / outputSchema / annotations differs.
 *   Comparing with a withdrawn revision counts every tool as added.
 * - Safe under concurrency: the read-compare-insert runs under a transaction
 *   advisory lock per item and source, so two parallel callers neither
 *   duplicate nor skip a revision number (the unique index is the backstop).
 * - Retention: the latest {@link TOOL_REVISIONS_KEPT_FULL} revisions of an item
 *   and source keep their full list; older ones keep only the diff, and rows
 *   beyond {@link TOOL_REVISIONS_KEPT_ROWS} are deleted, oldest first.
 * - Rate: at most {@link TOOL_REVISIONS_PER_DAY} new revisions per item and
 *   source in a rolling 24 hours (measured from `observedAt`); beyond that the
 *   outcome is `throttled` and nothing is written.
 * - A canonical-form bump never creates a revision: the previous list is
 *   re-canonicalised before comparing and diffing, and a confirmed revision
 *   is upgraded to the current form.
 * - Pass `tx` to record inside the caller's transaction (the owner path does,
 *   so the list and its history commit together); the lock is then held until
 *   that transaction ends. Without it the call runs its own transaction.
 * - No member or team identifier is accepted or stored.
 */
export async function recordToolRevision(
  input: RecordToolRevisionInput,
  options: { tx?: ToolRevisionTx } = {},
): Promise<ToolRevisionOutcome> {
  const canonical = canonicalizeTools(validateTools(input.tools));
  const toolsHash = hashCanonicalTools(canonical);
  const observedAt = input.observedAt ?? new Date();
  const run = async (tx: ToolRevisionTx): Promise<ToolRevisionOutcome> => {
    await lockSource(tx, input.itemId, input.source);
    const latest = await latestRevision(tx, input.itemId, input.source);
    if (input.skipWhenTakenDown && latest?.withdrawn) {
      return { outcome: "taken-down", revision: null, toolsHash, diff: null };
    }
    const previous = previousList(latest);
    if (latest && previous.hash === toolsHash) {
      await tx
        .update(marketMcpToolRevisions)
        .set({
          lastConfirmedAt: sql`greatest(${marketMcpToolRevisions.lastConfirmedAt}, ${observedAt})`,
          // Only a confirmation that is not older than the latest one moves
          // the pin forward: a late, older read must not mark the list fresh.
          ...(input.endpointKey !== undefined && observedAt >= latest.lastConfirmedAt
            ? {
                endpointKey: input.endpointKey,
                referenceProfileJson: input.referenceProfile ?? null,
              }
            : {}),
          // A revision made under an older canonical form moves to the
          // current one, so its hash and version never disagree with the form.
          ...(latest.canonicalVersion !== TOOL_CANONICAL_VERSION
            ? {
                canonicalVersion: TOOL_CANONICAL_VERSION,
                toolsHash,
                toolsJson: latest.toolsJson ? canonical : null,
              }
            : {}),
        })
        .where(eq(marketMcpToolRevisions.id, latest.id));
      return { outcome: "confirmed", revision: latest.revision, toolsHash, diff: null };
    }
    if (await madeTooMany(tx, input.itemId, input.source, observedAt)) {
      return { outcome: "throttled", revision: null, toolsHash, diff: null };
    }
    const diff = diffTools(previous.tools, canonical);
    const revision = (latest?.revision ?? 0) + 1;
    await insertRevision(tx, {
      itemId: input.itemId,
      source: input.source,
      revision,
      toolsHash,
      withdrawn: false,
      tools: canonical,
      diff,
      serverVersion: input.serverVersion ?? null,
      observedAt,
      endpointKey: input.endpointKey ?? null,
      referenceProfile: input.referenceProfile ?? null,
    });
    return { outcome: "created", revision, toolsHash, diff };
  };
  return options.tx ? run(options.tx) : db.transaction(run);
}

/**
 * The source takes its list back (an owner clears it, an admin's block removes
 * it): records a revision marked `withdrawn`, which is not the same as
 * publishing a valid empty list. Nothing is recorded when the source has no
 * list to take back. The history stays; a later `recordToolRevision` from the
 * same source starts a new revision against the empty list.
 */
export async function withdrawToolRevision(
  input: WithdrawToolRevisionInput,
  options: { tx?: ToolRevisionTx } = {},
): Promise<WithdrawToolRevisionOutcome> {
  const observedAt = input.observedAt ?? new Date();
  const run = async (tx: ToolRevisionTx): Promise<WithdrawToolRevisionOutcome> => {
    await lockSource(tx, input.itemId, input.source);
    const latest = await latestRevision(tx, input.itemId, input.source);
    if (!latest || latest.withdrawn) return { outcome: "none" };
    const diff = diffTools(previousList(latest).tools, []);
    const revision = latest.revision + 1;
    await insertRevision(tx, {
      itemId: input.itemId,
      source: input.source,
      revision,
      toolsHash: WITHDRAWN_TOOLS_HASH,
      withdrawn: true,
      tools: [],
      diff,
      serverVersion: null,
      observedAt,
      endpointKey: null,
      referenceProfile: null,
    });
    return { outcome: "withdrawn", revision, diff };
  };
  return options.tx ? run(options.tx) : db.transaction(run);
}

// A key space of its own: the claim locks use the one-argument form.
const TOOL_REVISION_LOCK_NAMESPACE = 0x544c5256;

async function lockSource(
  tx: ToolRevisionTx,
  itemId: string,
  source: McpToolRevisionSource,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${TOOL_REVISION_LOCK_NAMESPACE}::int, hashtext(${`${itemId}:${source}`}))`,
  );
}

/** Revisions this item and source already made in the 24 hours up to `at`. */
async function madeTooMany(
  tx: ToolRevisionTx,
  itemId: string,
  source: McpToolRevisionSource,
  at: Date,
): Promise<boolean> {
  const since = new Date(at.getTime() - 24 * 60 * 60 * 1000);
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(marketMcpToolRevisions)
    .where(
      and(
        eq(marketMcpToolRevisions.itemId, itemId),
        eq(marketMcpToolRevisions.source, source),
        gt(marketMcpToolRevisions.observedAt, since),
      ),
    );
  return (row?.count ?? 0) >= TOOL_REVISIONS_PER_DAY;
}

async function latestRevision(
  tx: ToolRevisionTx | typeof db,
  itemId: string,
  source: McpToolRevisionSource,
): Promise<RevisionRow | null> {
  const [row] = await tx
    .select()
    .from(marketMcpToolRevisions)
    .where(
      and(
        eq(marketMcpToolRevisions.itemId, itemId),
        eq(marketMcpToolRevisions.source, source),
      ),
    )
    .orderBy(desc(marketMcpToolRevisions.revision))
    .limit(1);
  return row ?? null;
}

/**
 * The latest revision's list and hash in the CURRENT canonical form. A revision
 * made under an older form is re-derived from its stored list (a pruned or
 * unreadable one has no comparable hash); a withdrawal is an empty list that
 * never equals any list.
 */
function previousList(row: RevisionRow | null): {
  tools: CanonicalTool[];
  hash: string | null;
} {
  if (!row) return { tools: [], hash: null };
  if (row.withdrawn) return { tools: [], hash: WITHDRAWN_TOOLS_HASH };
  const stored = Array.isArray(row.toolsJson) ? row.toolsJson : null;
  if (row.canonicalVersion === TOOL_CANONICAL_VERSION) {
    return { tools: (stored ?? []) as CanonicalTool[], hash: row.toolsHash };
  }
  if (!stored) return { tools: [], hash: null };
  try {
    const tools = canonicalizeTools(validateTools(stored));
    return { tools, hash: hashCanonicalTools(tools) };
  } catch {
    return { tools: stored as CanonicalTool[], hash: null };
  }
}

async function insertRevision(
  tx: ToolRevisionTx,
  row: {
    itemId: string;
    source: McpToolRevisionSource;
    revision: number;
    toolsHash: string;
    withdrawn: boolean;
    tools: CanonicalTool[];
    diff: ToolRevisionDiff;
    serverVersion: string | null;
    observedAt: Date;
    endpointKey: string | null;
    referenceProfile: Record<string, unknown> | null;
  },
) {
  await tx.insert(marketMcpToolRevisions).values({
    id: randomUUID(),
    itemId: row.itemId,
    source: row.source,
    revision: row.revision,
    toolsHash: row.toolsHash,
    canonicalVersion: TOOL_CANONICAL_VERSION,
    withdrawn: row.withdrawn,
    toolsCount: row.tools.length,
    toolsJson: row.tools,
    diffJson: row.diff,
    serverVersion: row.serverVersion?.slice(0, 200) ?? null,
    observedAt: row.observedAt,
    lastConfirmedAt: row.observedAt,
    endpointKey: row.endpointKey,
    referenceProfileJson: row.referenceProfile,
  });
  // Older revisions keep their diff summary only.
  await tx
    .update(marketMcpToolRevisions)
    .set({ toolsJson: null })
    .where(
      and(
        eq(marketMcpToolRevisions.itemId, row.itemId),
        eq(marketMcpToolRevisions.source, row.source),
        lte(
          marketMcpToolRevisions.revision,
          row.revision - TOOL_REVISIONS_KEPT_FULL,
        ),
        sql`${marketMcpToolRevisions.toolsJson} is not null`,
      ),
    );
  // And a ceiling on the rows themselves.
  await tx
    .delete(marketMcpToolRevisions)
    .where(
      and(
        eq(marketMcpToolRevisions.itemId, row.itemId),
        eq(marketMcpToolRevisions.source, row.source),
        lte(marketMcpToolRevisions.revision, row.revision - TOOL_REVISIONS_KEPT_ROWS),
      ),
    );
}

/**
 * Deletes a source's whole history for an item. For when what the history
 * describes must not stay public — an admin block removes the blocked member's
 * list, and with it every earlier revision of that source. The numbering of a
 * later list starts again at 1.
 */
export async function purgeToolRevisions(
  input: { itemId: string; source: McpToolRevisionSource },
  options: { tx?: ToolRevisionTx } = {},
): Promise<void> {
  const run = async (tx: ToolRevisionTx) => {
    await lockSource(tx, input.itemId, input.source);
    await tx
      .delete(marketMcpToolRevisions)
      .where(
        and(
          eq(marketMcpToolRevisions.itemId, input.itemId),
          eq(marketMcpToolRevisions.source, input.source),
        ),
      );
  };
  await (options.tx ? run(options.tx) : db.transaction(run));
}

/**
 * An admin takes a source's recorded tools down: the whole history of the
 * source is deleted and replaced by one `withdrawn` marker, which keeps
 * `isToolSourceTakenDown` true so the source is not recorded again until
 * {@link restoreToolSource}. Only the platform snapshot and the members'
 * observation are taken down this way; an owner's list belongs to its claim.
 */
export async function takedownToolSource(
  input: { itemId: string; source: Exclude<McpToolRevisionSource, "owner">; at?: Date },
  options: { tx?: ToolRevisionTx } = {},
): Promise<void> {
  const at = input.at ?? new Date();
  const run = async (tx: ToolRevisionTx) => {
    await lockSource(tx, input.itemId, input.source);
    await tx
      .delete(marketMcpToolRevisions)
      .where(
        and(
          eq(marketMcpToolRevisions.itemId, input.itemId),
          eq(marketMcpToolRevisions.source, input.source),
        ),
      );
    await insertRevision(tx, {
      itemId: input.itemId,
      source: input.source,
      revision: 1,
      toolsHash: WITHDRAWN_TOOLS_HASH,
      withdrawn: true,
      tools: [],
      diff: { added: [], removed: [], changed: [] },
      serverVersion: null,
      observedAt: at,
      endpointKey: null,
      referenceProfile: null,
    });
  };
  await (options.tx ? run(options.tx) : db.transaction(run));
}

/**
 * Lets a taken-down source be recorded again. Deletes the marker (and anything
 * else of the source, which a takedown already emptied); false when the source
 * was not taken down, in which case nothing is touched.
 */
export async function restoreToolSource(
  input: { itemId: string; source: Exclude<McpToolRevisionSource, "owner"> },
  options: { tx?: ToolRevisionTx } = {},
): Promise<boolean> {
  const run = async (tx: ToolRevisionTx) => {
    await lockSource(tx, input.itemId, input.source);
    const latest = await latestRevision(tx, input.itemId, input.source);
    if (!latest?.withdrawn) return false;
    await tx
      .delete(marketMcpToolRevisions)
      .where(
        and(
          eq(marketMcpToolRevisions.itemId, input.itemId),
          eq(marketMcpToolRevisions.source, input.source),
        ),
      );
    return true;
  };
  return options.tx ? run(options.tx) : db.transaction(run);
}

/** Whether the source's latest revision is a withdrawal (an admin's takedown). */
export async function isToolSourceTakenDown(
  input: { itemId: string; source: McpToolRevisionSource },
  options: { tx?: ToolRevisionTx } = {},
): Promise<boolean> {
  const latest = await latestRevision(options.tx ?? db, input.itemId, input.source);
  return latest?.withdrawn === true;
}
