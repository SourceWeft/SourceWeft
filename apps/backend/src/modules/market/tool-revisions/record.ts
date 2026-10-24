import { randomUUID } from "node:crypto";
import { and, desc, eq, lte, sql } from "drizzle-orm";
import {
  db,
  marketMcpToolRevisions,
  type McpToolRevisionSource,
} from "@sourceweft/db";
import {
  TOOL_CANONICAL_VERSION,
  TOOL_REVISIONS_KEPT_FULL,
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
 *   and source keep their full list; older ones keep only the diff.
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
    if (latest && (await sameList(latest, toolsHash))) {
      await tx
        .update(marketMcpToolRevisions)
        .set({
          lastConfirmedAt: sql`greatest(${marketMcpToolRevisions.lastConfirmedAt}, ${observedAt})`,
        })
        .where(eq(marketMcpToolRevisions.id, latest.id));
      return { outcome: "confirmed", revision: latest.revision, toolsHash, diff: null };
    }
    const diff = diffTools(toolsOf(latest), canonical);
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
    const diff = diffTools(toolsOf(latest), []);
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
    });
    return { outcome: "withdrawn", revision, diff };
  };
  return options.tx ? run(options.tx) : db.transaction(run);
}

async function lockSource(
  tx: ToolRevisionTx,
  itemId: string,
  source: McpToolRevisionSource,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`mcp-tool-revisions:${itemId}:${source}`}))`,
  );
}

async function latestRevision(
  tx: ToolRevisionTx,
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

/** The recorded list as canonical tools (empty for none or a withdrawal). */
function toolsOf(row: RevisionRow | null): CanonicalTool[] {
  if (!row || row.withdrawn || !Array.isArray(row.toolsJson)) return [];
  return row.toolsJson as CanonicalTool[];
}

/**
 * Is the latest revision the same list? A revision made under an older
 * canonical form is re-derived from its stored list, so changing the form
 * alone never creates a revision; without a stored list it counts as different.
 */
async function sameList(latest: RevisionRow, toolsHash: string): Promise<boolean> {
  if (latest.withdrawn) return false;
  if (latest.canonicalVersion === TOOL_CANONICAL_VERSION) {
    return latest.toolsHash === toolsHash;
  }
  if (!Array.isArray(latest.toolsJson)) return false;
  try {
    const rederived = hashCanonicalTools(
      canonicalizeTools(validateTools(latest.toolsJson)),
    );
    return rederived === toolsHash;
  } catch {
    return false;
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
}
