/**
 * Contract for the self-hosted async-subagent runs endpoint.
 *
 * deepagents' `createAsyncSubAgentMiddleware` drives background delegates over
 * an Agent-Protocol / LangGraph-Server-compatible endpoint (langgraph-sdk
 * `Client`): `threads.create`, `runs.create` (with a `multitask_strategy`),
 * `runs.get`, `threads.getState`, `runs.cancel`. We self-host that endpoint on
 * the existing BullMQ + Postgres infra instead of the ELv2 official server.
 *
 * This module declares the vocabulary only — the state machine lives in
 * `run-state.ts`, the store implementation and HTTP routes are separate.
 */

/**
 * Run lifecycle status. Aligned with deepagents' `AsyncTaskStatus` and the
 * LangGraph Server / Agent Protocol run statuses so the SDK client reads them
 * without translation.
 */
export type AsyncRunStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "interrupted"
  | "timeout"
  | "cancelled";

/**
 * Double-texting policy applied when a run is created on a thread that already
 * has an active (non-terminal) run. Mirrors the LangGraph Server
 * `multitask_strategy`. deepagents' `update_async_task` (continued messaging)
 * uses `"interrupt"`.
 */
export type MultitaskStrategy = "reject" | "interrupt" | "rollback" | "enqueue";

/** A durable run record — one background execution of a delegate graph. */
export interface RunRecord {
  runId: string;
  threadId: string;
  /** The delegate graph this run executes (deepagents `AsyncSubAgent.graphId`). */
  graphId: string;
  status: AsyncRunStatus;
  /** Multitask policy this run was created under. */
  multitaskStrategy: MultitaskStrategy;
  createdAt: string;
  updatedAt: string;
}

/** A durable thread — a delegate conversation that runs can be created against. */
export interface ThreadRecord {
  threadId: string;
  createdAt: string;
}

/**
 * The operations the async endpoint exposes, matching the langgraph-sdk calls
 * deepagents makes. A BullMQ + Postgres implementation backs it; the HTTP layer
 * is a thin translation to/from the Agent Protocol shapes.
 */
export interface RunsStore {
  createThread(): Promise<ThreadRecord>;
  /**
   * Create a run on a thread. When the thread has an active run, the
   * `multitaskStrategy` decides what happens (see `resolveMultitask`).
   */
  createRun(input: {
    threadId: string;
    graphId: string;
    multitaskStrategy: MultitaskStrategy;
  }): Promise<RunRecord>;
  getRun(threadId: string, runId: string): Promise<RunRecord | null>;
  listRuns(threadId: string): Promise<RunRecord[]>;
  cancelRun(threadId: string, runId: string): Promise<RunRecord | null>;
  /** The thread's current checkpoint state (delegate transcript / result). */
  getThreadState(threadId: string): Promise<unknown>;
}
