/**
 * HTTP mount for the async-runs endpoint. A thin Hono adapter over the tested
 * Agent-Protocol handlers (`async-runs/http-router.ts`) — route → params/body →
 * handler → JSON. The langgraph-sdk `Client` deepagents drives talks to these
 * routes; the returned JSON is the raw Agent-Protocol shape (not our ApiResponse
 * envelope), so the SDK reads it directly.
 *
 * This endpoint is internal (our own async-subagent middleware calls it at a
 * local URL). Mount it behind the caller's chosen guard (a shared internal token
 * or loopback-only), passing the `RunsStore` — production uses `PostgresRunsStore`.
 */
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { RunsStore } from "../../modules/threads/agent/async-runs/types";
import {
  handleCancelRun,
  handleCreateRun,
  handleCreateThread,
  handleGetRun,
  handleGetThreadState,
  handleListRuns,
} from "../../modules/threads/agent/async-runs/http-router";

export function registerAsyncRunsRoutes(app: Hono, store: RunsStore) {
  app.post("/threads", async (c) => {
    const r = await handleCreateThread(store);
    return c.json(r.body, r.status as ContentfulStatusCode);
  });

  app.post("/threads/:threadId/runs", async (c) => {
    const body = await c.req.json().catch(() => null);
    const r = await handleCreateRun(store, c.req.param("threadId"), body);
    return c.json(r.body, r.status as ContentfulStatusCode);
  });

  app.get("/threads/:threadId/runs", async (c) => {
    const r = await handleListRuns(store, c.req.param("threadId"));
    return c.json(r.body, r.status as ContentfulStatusCode);
  });

  app.get("/threads/:threadId/runs/:runId", async (c) => {
    const r = await handleGetRun(
      store,
      c.req.param("threadId"),
      c.req.param("runId"),
    );
    return c.json(r.body, r.status as ContentfulStatusCode);
  });

  app.post("/threads/:threadId/runs/:runId/cancel", async (c) => {
    const r = await handleCancelRun(
      store,
      c.req.param("threadId"),
      c.req.param("runId"),
    );
    return c.json(r.body, r.status as ContentfulStatusCode);
  });

  app.get("/threads/:threadId/state", async (c) => {
    const r = await handleGetThreadState(store, c.req.param("threadId"));
    return c.json(r.body, r.status as ContentfulStatusCode);
  });
}
