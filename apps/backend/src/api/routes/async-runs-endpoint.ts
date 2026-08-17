/**
 * Internal mount for the async-runs endpoint (API process only).
 *
 * deepagents' async task tools drive background delegates over this endpoint via
 * the langgraph-sdk `Client` at `config.chat.agent.asyncRunsEndpointUrl`
 * (loopback by default). It is NOT part of the public API surface: it is mounted
 * under `/internal/async-runs` behind a fail-closed shared-token guard, and only
 * when async subagents are enabled.
 *
 * The route adapter (`registerAsyncRunsRoutes`) is framework-thin; this module
 * owns the app-level wiring the adapter needs: the durable `PostgresRunsStore`,
 * the BullMQ enqueue, and the guard.
 */
import { Hono } from "hono";
import { database } from "@sourceweft/db";
import { config } from "../../shared/config";
import { logger } from "../../shared/logger";
import { PostgresRunsStore } from "../../modules/threads/agent/async-runs/postgres-store";
import {
  createRunQueue,
  enqueueRun,
} from "../../modules/threads/agent/async-runs/run-queue";
import { RUN_INTERNAL_TOKEN_HEADER } from "../../modules/threads/agent/async-runs/run-context-header";
import { registerAsyncRunsRoutes } from "./async-runs";

let cachedStore: PostgresRunsStore | null = null;

/** The process-wide runs store (lazy). Shared by the endpoint and startup. */
export function getAsyncRunsStore(): PostgresRunsStore {
  if (!cachedStore) {
    cachedStore = new PostgresRunsStore(database);
  }
  return cachedStore;
}

/**
 * Create the endpoint's tables. Call once at API startup (before serving) when
 * the feature is enabled, so the SDK client never races an unbootstrapped store.
 */
export async function ensureAsyncRunsSchema(): Promise<void> {
  if (!config.chat.agent.asyncSubagentsEnabled) {
    return;
  }
  await getAsyncRunsStore().ensureSchema();
}

/**
 * Mount the guarded internal endpoint on the app. No-op when async subagents are
 * disabled, so the routes don't exist at all in the default configuration.
 */
export function mountInternalAsyncRuns(app: Hono): void {
  if (!config.chat.agent.asyncSubagentsEnabled) {
    return;
  }
  const token = config.chat.agent.asyncRunsInternalToken;
  if (!token) {
    // Enabled but unconfigured: mounting a guard with an empty token would
    // reject everything anyway; surface the misconfiguration loudly and skip.
    logger.error(
      "Async subagents enabled but SOURCEWEFT_AGENT_ASYNC_RUNS_INTERNAL_TOKEN is unset; endpoint NOT mounted",
    );
    return;
  }

  const queue = createRunQueue();
  const sub = new Hono();
  // Fail-closed shared-token guard. Constant-time compare is unnecessary here:
  // the token never leaves the internal network and this is defense-in-depth
  // behind network policy, not the primary boundary.
  sub.use("*", async (c, next) => {
    if (c.req.header(RUN_INTERNAL_TOKEN_HEADER) !== token) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  });
  registerAsyncRunsRoutes(sub, getAsyncRunsStore(), {
    enqueue: (job) => enqueueRun(queue, job),
  });
  app.route("/internal/async-runs", sub);
  logger.info("Internal async-runs endpoint mounted", {
    path: "/internal/async-runs",
  });
}
