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
import {
  RUN_CONTEXT_HEADER,
  decodeRunContextHeader,
} from "../../modules/threads/agent/async-runs/run-context-header";

/** A newly created, ready-to-run job the worker should pick up. */
export interface EnqueueRunJob {
  runId: string;
  threadId: string;
  graphId: string;
}

export interface AsyncRunsRoutesOptions {
  /**
   * Enqueue a created run for the worker. The store only records the run row;
   * this hands it to BullMQ. Called only for runs that start immediately
   * (status `running`) — `pending` (enqueue-strategy) runs are chained when the
   * active run finishes (not yet implemented; deepagents never sends enqueue).
   */
  enqueue?: (job: EnqueueRunJob) => Promise<void>;
}

export function registerAsyncRunsRoutes(
  app: Hono,
  store: RunsStore,
  options: AsyncRunsRoutesOptions = {},
) {
  app.post("/threads", async (c) => {
    const r = await handleCreateThread(store);
    return c.json(r.body, r.status as ContentfulStatusCode);
  });

  app.post("/threads/:threadId/runs", async (c) => {
    const body = await c.req.json().catch(() => null);
    const context = decodeRunContextHeader(c.req.header(RUN_CONTEXT_HEADER));
    const r = await handleCreateRun(
      store,
      c.req.param("threadId"),
      body,
      context,
    );
    // Enqueue only a run that actually started; the store applied the multitask
    // policy, so a superseded/rejected create never reaches here as `running`.
    const run = r.body as { run_id?: string; status?: string; assistant_id?: string };
    if (r.status === 201 && run.status === "running" && options.enqueue) {
      await options.enqueue({
        runId: run.run_id!,
        threadId: c.req.param("threadId"),
        graphId: run.assistant_id!,
      });
    }
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
