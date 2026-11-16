import { logger } from "../../shared/logger";

type Item = { occurrence: { id: string }; schedule: { id: string } };

export type SchedulePhase = "reconcile" | "recover";

/**
 * What a schedule kind plugs into the engine. The engine owns the tick shape
 * (materialize, reconcile queued, recover stale, dispatch, then upkeep) and
 * the per-item error isolation; the adapter owns everything that depends on
 * what the occurrence runs.
 */
export interface ScheduleAdapter<
  Queued extends Item,
  Stale extends Item,
  Claimed extends Item,
> {
  /** Names the kind in log lines. */
  label: string;
  /** Items handled per phase per tick. */
  limit: number;
  /** A running occurrence idle for this long is inspected for recovery. */
  staleAfterMs: number;
  materialize(input: { now: Date; limit: number }): Promise<unknown>;
  /** The DB occurrence is the outbox: queue entries may be lost, so replay. */
  listQueued(limit: number): Promise<Queued[]>;
  reconcileQueued(item: Queued): Promise<void>;
  listStale(input: { cutoff: Date; limit: number }): Promise<Stale[]>;
  recoverStale(item: Stale): Promise<void>;
  claim(input: { now: Date; limit: number }): Promise<Claimed[]>;
  /** Owns its own retry/skip decisions; an escaping throw aborts the tick. */
  dispatch(item: Claimed): Promise<void>;
  /** Kind-specific upkeep after dispatch (for example resuming blocked work). */
  afterTick?(now: Date): Promise<void>;
  onError?(phase: SchedulePhase, item: Item, error: unknown): void;
}

export async function runScheduleTick<
  Queued extends Item,
  Stale extends Item,
  Claimed extends Item,
>(adapter: ScheduleAdapter<Queued, Stale, Claimed>, now = new Date()) {
  const fail = (phase: SchedulePhase, item: Item, error: unknown) => {
    if (adapter.onError) {
      adapter.onError(phase, item, error);
      return;
    }
    logger.error(`Failed to ${phase} ${adapter.label} schedule occurrence`, {
      occurrenceId: item.occurrence.id,
      scheduleId: item.schedule.id,
      message: error instanceof Error ? error.message : String(error),
    });
  };

  await adapter.materialize({ now, limit: adapter.limit });

  for (const item of await adapter.listQueued(adapter.limit * 2)) {
    try {
      await adapter.reconcileQueued(item);
    } catch (error) {
      fail("reconcile", item, error);
    }
  }

  const stale = await adapter.listStale({
    cutoff: new Date(now.getTime() - adapter.staleAfterMs),
    limit: adapter.limit,
  });
  for (const item of stale) {
    try {
      await adapter.recoverStale(item);
    } catch (error) {
      fail("recover", item, error);
    }
  }

  // Dispatch decides retry, skip and failure itself; whatever it still throws
  // (a lost database, say) aborts the tick so the scheduler raises its alert.
  for (const item of await adapter.claim({ now, limit: adapter.limit })) {
    await adapter.dispatch(item);
  }

  await adapter.afterTick?.(now);
}
