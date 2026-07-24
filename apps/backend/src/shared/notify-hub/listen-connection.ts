import type { Client } from "pg";
import { createDedicatedClient } from "@sourceweft/db";
import { logger } from "../logger";
import { metrics } from "../metrics";
import { THREAD_EVENTS_CHANNEL, type ThreadEventPayload } from "./types";

const BACKOFF_MIN_MS = 250;
const BACKOFF_MAX_MS = 30_000;

/**
 * Owns the dedicated `LISTEN thread_events` connection for one process. A LISTEN
 * registration is per-backend and is lost when the connection drops, so this
 * reconnects with capped exponential backoff and re-issues LISTEN every time.
 */
export class ListenConnection {
  private client: Client | null = null;
  private stopped = false;
  private attempt = 0;
  // When the current connection was established. Backoff is only reset once a
  // connection has stayed up this long, so a connection that flaps immediately
  // keeps escalating the delay instead of hammering the DB every 250ms.
  private connectedAt: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onPayload: (payload: ThreadEventPayload) => void,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.end();
      } catch (error) {
        logger.warn("NotifyHub listen connection failed to end cleanly", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const client = createDedicatedClient();
    client.on("error", (error) => this.handleDrop(client, error));
    client.on("end", () => this.handleDrop(client, null));
    client.on("notification", (message) => {
      if (message.channel !== THREAD_EVENTS_CHANNEL || !message.payload) {
        return;
      }
      let payload: ThreadEventPayload;
      try {
        payload = JSON.parse(message.payload) as ThreadEventPayload;
      } catch (error) {
        logger.warn("NotifyHub received an unparseable notification", {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      this.onPayload(payload);
    });

    try {
      await client.connect();
      // Channel name is a fixed constant, not user input (LISTEN cannot be
      // parameterized anyway).
      await client.query(`LISTEN ${THREAD_EVENTS_CHANNEL}`);
      if (this.stopped) {
        // stop() raced this connect: it saw a null this.client and closed
        // nothing, so end the freshly established client rather than adopt it.
        await client.end().catch(() => undefined);
        return;
      }
      this.client = client;
      this.connectedAt = Date.now();
      metrics.gauge("notify_hub.listener.up", 1);
      logger.info("NotifyHub is listening for thread events");
    } catch (error) {
      logger.warn("NotifyHub listen connection failed; will retry", {
        error: error instanceof Error ? error.message : String(error),
      });
      await client.end().catch(() => undefined);
      this.scheduleReconnect();
    }
  }

  private handleDrop(client: Client, error: Error | null): void {
    // Ignore events from a client we have already replaced or torn down.
    if (this.client !== client) {
      return;
    }
    this.client = null;
    metrics.gauge("notify_hub.listener.up", 0);
    metrics.inc("notify_hub.listener.down");
    if (this.stopped) {
      return;
    }
    // Reset backoff only if the connection proved stable; a connection that
    // drops within the window keeps the delay escalating toward the cap.
    if (
      this.connectedAt !== null &&
      Date.now() - this.connectedAt >= BACKOFF_MAX_MS
    ) {
      this.attempt = 0;
    }
    this.connectedAt = null;
    if (error) {
      logger.warn("NotifyHub listen connection dropped", {
        error: error.message,
      });
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    metrics.inc("notify_hub.listener.reconnects");
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}
