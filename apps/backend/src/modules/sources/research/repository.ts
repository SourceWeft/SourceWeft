import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, sourceResearchRuns } from "@sourceweft/db";
import type {
  ResearchCitation,
  ResearchErrorCode,
  ResearchLedgerEntry,
  ResearchPhase,
  ResearchProgress,
} from "@sourceweft/contracts/source-research";

export type ResearchRunRow = typeof sourceResearchRuns.$inferSelect;

const ACTIVE = ["queued", "running"] as const;
const NON_TERMINAL = ["queued", "running"] as const;

interface RunScope {
  teamId: string;
  workspaceId: string;
}

/**
 * Creates a queued run. Accepts an executor so the insert can run on the same
 * connection as the admission count under an advisory lock; defaults to the
 * shared pool for every other caller.
 */
export async function createRun(
  input: RunScope & { userId: string; topic: string },
  executor: Pick<typeof db, "insert"> = db,
): Promise<ResearchRunRow> {
  const [row] = await executor
    .insert(sourceResearchRuns)
    .values({
      id: randomUUID(),
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      createdByUserId: input.userId,
      topic: input.topic,
      status: "queued",
    })
    .returning();
  if (!row) throw new Error("research run insert returned no row");
  return row;
}

export async function findRun(
  input: RunScope & { id: string },
): Promise<ResearchRunRow | null> {
  const [row] = await db
    .select()
    .from(sourceResearchRuns)
    .where(
      and(
        eq(sourceResearchRuns.id, input.id),
        eq(sourceResearchRuns.teamId, input.teamId),
        eq(sourceResearchRuns.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listRuns(
  input: RunScope & { limit: number },
): Promise<ResearchRunRow[]> {
  return db
    .select()
    .from(sourceResearchRuns)
    .where(
      and(
        eq(sourceResearchRuns.teamId, input.teamId),
        eq(sourceResearchRuns.workspaceId, input.workspaceId),
      ),
    )
    .orderBy(desc(sourceResearchRuns.createdAt))
    .limit(input.limit);
}

/** queued -> running; false when the run was not queued. */
export async function markRunning(id: string): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(sourceResearchRuns)
    .set({ status: "running", startedAt: now, updatedAt: now })
    .where(
      and(
        eq(sourceResearchRuns.id, id),
        eq(sourceResearchRuns.status, "queued"),
      ),
    )
    .returning({ id: sourceResearchRuns.id });
  return rows.length > 0;
}

/** Writes only the given fields, and never to a terminal run. */
export async function saveProgress(
  id: string,
  patch: {
    phase?: ResearchPhase;
    progress?: ResearchProgress;
    plan?: string[];
    ledger?: ResearchLedgerEntry[];
    modelCalls?: number;
  },
): Promise<void> {
  await db
    .update(sourceResearchRuns)
    .set({
      updatedAt: new Date(),
      ...(patch.phase !== undefined ? { phase: patch.phase } : {}),
      ...(patch.progress !== undefined ? { progressJson: patch.progress } : {}),
      ...(patch.plan !== undefined ? { planJson: patch.plan } : {}),
      ...(patch.ledger !== undefined ? { ledgerJson: patch.ledger } : {}),
      ...(patch.modelCalls !== undefined
        ? {
            modelCalls: sql`greatest(${sourceResearchRuns.modelCalls}, ${patch.modelCalls})`,
          }
        : {}),
    })
    .where(
      and(
        eq(sourceResearchRuns.id, id),
        inArray(sourceResearchRuns.status, ACTIVE),
      ),
    );
}

/**
 * queued -> cancelled directly; running -> cancel_requested_at only (the loop
 * finishes the cancel); terminal -> false.
 */
export async function requestCancel(
  input: RunScope & { id: string },
): Promise<boolean> {
  const now = new Date();
  const scope = and(
    eq(sourceResearchRuns.id, input.id),
    eq(sourceResearchRuns.teamId, input.teamId),
    eq(sourceResearchRuns.workspaceId, input.workspaceId),
  );
  const queued = await db
    .update(sourceResearchRuns)
    .set({
      status: "cancelled",
      cancelRequestedAt: now,
      finishedAt: now,
      updatedAt: now,
    })
    .where(and(scope, eq(sourceResearchRuns.status, "queued")))
    .returning({ id: sourceResearchRuns.id });
  if (queued.length > 0) return true;
  const running = await db
    .update(sourceResearchRuns)
    .set({ cancelRequestedAt: now, updatedAt: now })
    .where(and(scope, eq(sourceResearchRuns.status, "running")))
    .returning({ id: sourceResearchRuns.id });
  return running.length > 0;
}

export async function isCancelRequested(id: string): Promise<boolean> {
  const rows = await db
    .select({ id: sourceResearchRuns.id })
    .from(sourceResearchRuns)
    .where(
      and(
        eq(sourceResearchRuns.id, id),
        isNotNull(sourceResearchRuns.cancelRequestedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function finish(
  id: string,
  set: Partial<typeof sourceResearchRuns.$inferInsert>,
): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(sourceResearchRuns)
    .set({ ...set, finishedAt: now, updatedAt: now })
    .where(
      and(
        eq(sourceResearchRuns.id, id),
        inArray(sourceResearchRuns.status, NON_TERMINAL),
      ),
    )
    .returning({ id: sourceResearchRuns.id });
  return rows.length > 0;
}

export function finishReady(
  id: string,
  result: { report: string; citations: ResearchCitation[] },
): Promise<boolean> {
  return finish(id, {
    status: "ready",
    reportMarkdown: result.report,
    reportCitationsJson: result.citations,
    errorCode: null,
  });
}

export function finishFailed(
  id: string,
  errorCode: ResearchErrorCode,
): Promise<boolean> {
  return finish(id, { status: "failed", errorCode });
}

export function finishCancelled(id: string): Promise<boolean> {
  return finish(id, { status: "cancelled" });
}
