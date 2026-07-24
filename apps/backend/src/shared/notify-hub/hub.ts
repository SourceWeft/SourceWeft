import { logger } from "../logger";
import { ListenConnection } from "./listen-connection";
import type { ThreadEventPayload, ThreadEventSubscriber } from "./types";

/**
 * In-process fan-out for thread events. One dedicated LISTEN connection feeds
 * every subscriber registered on this process; `dispatch` routes by `threadId`
 * to only the local sockets that care. Across replicas each process runs its own
 * hub — `pg_notify` reaches all of them, so a client on one replica still sees
 * events produced on another. No cross-replica forwarding, no sticky sessions.
 */
export class NotifyHub {
  private readonly byThread = new Map<string, Set<ThreadEventSubscriber>>();
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
  }

  /** Register a subscriber for a thread; returns an idempotent unsubscribe. */
  subscribe(threadId: string, subscriber: ThreadEventSubscriber): () => void {
    let set = this.byThread.get(threadId);
    if (!set) {
      set = new Set();
      this.byThread.set(threadId, set);
    }
    set.add(subscriber);
    return () => {
      const current = this.byThread.get(threadId);
      if (!current) {
        return;
      }
      current.delete(subscriber);
      if (current.size === 0) {
        // Bound memory: never keep empty sets around for dead threads.
        this.byThread.delete(threadId);
      }
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
