import { randomUUID } from "node:crypto";
import { logger } from "../logger";
import { metrics } from "../metrics";
import { ListenConnection } from "./listen-connection";
import type { ThreadEventPayload, ThreadEventSubscriber } from "./types";

// Bound per-replica room fan-out. Generous safety ceilings — normal threads have
// single-digit viewers; these guard memory/FD/fan-out under pathological load.
const PER_THREAD_CAP = Number(process.env.ROOM_PER_THREAD_CAP || 200);
const TOTAL_CAP = Number(process.env.ROOM_TOTAL_CAP || 10_000);

/** A held admission slot: `attach` the real subscriber, `release` to free it. */
export type RoomReservation = {
  attach: (subscriber: ThreadEventSubscriber) => void;
  release: () => void;
};

export type ReserveResult =
  | { ok: true; reservation: RoomReservation }
  | { ok: false; reason: "per_thread" | "total" };

/**
 * In-process fan-out for thread events. One dedicated LISTEN connection feeds
 * every subscriber registered on this process; `dispatch` routes by `threadId`
 * to only the local sockets that care. Across replicas each process runs its own
 * hub — `pg_notify` reaches all of them, so a client on one replica still sees
 * events produced on another. No cross-replica forwarding, no sticky sessions.
 */
export class NotifyHub {
  private readonly byThread = new Map<string, Set<ThreadEventSubscriber>>();
  private readonly highWaterByThread = new Map<string, number>();
  private total = 0;
  private readonly connection: ListenConnection;

  constructor() {
    this.connection = new ListenConnection((payload) => this.dispatch(payload));
  }

  async start(): Promise<void> {
    await this.connection.start();
  }

  async stop(): Promise<void> {
    await this.connection.stop();
    this.byThread.clear();
    this.highWaterByThread.clear();
    this.total = 0;
  }

  private add(threadId: string, subscriber: ThreadEventSubscriber): void {
    let set = this.byThread.get(threadId);
    if (!set) {
      set = new Set();
      this.byThread.set(threadId, set);
    }
    set.add(subscriber);
    this.total += 1;
    this.highWaterByThread.set(
      threadId,
      Math.max(this.highWaterByThread.get(threadId) ?? 0, set.size),
    );
    metrics.gauge("room.subscribers.total", this.total);
  }

  private remove(threadId: string, subscriber: ThreadEventSubscriber): void {
    const set = this.byThread.get(threadId);
    if (!set) {
      return;
    }
    if (set.delete(subscriber)) {
      this.total -= 1;
      metrics.gauge("room.subscribers.total", this.total);
    }
    if (set.size === 0) {
      // Snapshot the peak before dropping so a thread that fully drains between
      // flushes still reports its high-water. Bound memory: no empty sets kept.
      const highWater = this.highWaterByThread.get(threadId);
      if (highWater) {
        metrics.observe("room.thread.high_water", highWater);
      }
      this.highWaterByThread.delete(threadId);
      this.byThread.delete(threadId);
    }
  }

  /**
   * Atomically admit a room connection under the caps. On success a placeholder
   * subscriber holds the counted slot; `attach` swaps in the real subscriber
   * (count unchanged) and `release` frees the slot (idempotent). The reserve →
   * attach handoff guarantees the slot the generator attaches to is the exact
   * slot admission counted — no over-admission under concurrency.
   */
  reserve(threadId: string): ReserveResult {
    if (this.total >= TOTAL_CAP) {
      metrics.inc("room.rejections", { reason: "total" });
      return { ok: false, reason: "total" };
    }
    if ((this.byThread.get(threadId)?.size ?? 0) >= PER_THREAD_CAP) {
      metrics.inc("room.rejections", { reason: "per_thread" });
      return { ok: false, reason: "per_thread" };
    }

    let current: ThreadEventSubscriber = {
      id: `__reserved_${randomUUID()}`,
      onEvent: () => undefined,
    };
    this.add(threadId, current);
    let released = false;

    return {
      ok: true,
      reservation: {
        attach: (subscriber) => {
          const set = this.byThread.get(threadId);
          if (set && set.delete(current)) {
            set.add(subscriber);
            current = subscriber;
          }
        },
        release: () => {
          if (released) {
            return;
          }
          released = true;
          this.remove(threadId, current);
        },
      },
    };
  }

  /** Uncapped registration (internal/non-room callers + tests). */
  subscribe(threadId: string, subscriber: ThreadEventSubscriber): () => void {
    this.add(threadId, subscriber);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.remove(threadId, subscriber);
    };
  }

  /** Deliver a payload to every subscriber of its thread. One failing
   * subscriber never breaks fan-out to the others. */
  dispatch(payload: ThreadEventPayload): void {
    const set = this.byThread.get(payload.threadId);
    if (!set) {
      return;
    }
    for (const subscriber of set) {
      try {
        subscriber.onEvent(payload);
      } catch (error) {
        logger.warn("NotifyHub subscriber threw during dispatch", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  subscriberCount(threadId: string): number {
    return this.byThread.get(threadId)?.size ?? 0;
  }
}

export const notifyHub = new NotifyHub();
