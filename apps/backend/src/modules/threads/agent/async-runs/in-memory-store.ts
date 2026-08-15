/**
 * In-memory {@link RunsStore} — the reference implementation and test double for
 * the async-runs endpoint. It wires the pure state machine + multitask resolver
 * into the full createRun/cancel/list flow, with no BullMQ/Postgres. The real
 * store mirrors this logic and swaps the maps for Postgres rows + BullMQ jobs.
 */
import type {
  AsyncRunStatus,
  MultitaskStrategy,
  RunRecord,
  RunsStore,
  ThreadRecord,
} from "./types";
import {
  canTransition,
  isTerminalRunStatus,
  resolveMultitask,
} from "./run-state";

/** Thrown when `multitask_strategy: "reject"` refuses a concurrent run. */
export class RunConflictError extends Error {
  constructor(readonly activeRunId: string) {
    super(`A run (${activeRunId}) is already active on this thread`);
    this.name = "RunConflictError";
  }
}

export class InMemoryRunsStore implements RunsStore {
  private readonly threads = new Map<string, ThreadRecord>();
  /** Insertion-ordered so the newest non-terminal run is the active one. */
  private readonly runs = new Map<string, RunRecord>();
  private seq = 0;

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  async createThread(): Promise<ThreadRecord> {
    const thread: ThreadRecord = {
      threadId: this.nextId("thread"),
      createdAt: this.now(),
    };
    this.threads.set(thread.threadId, thread);
    return thread;
  }

  /** The thread's newest non-terminal run, or null. */
  private activeRun(threadId: string): RunRecord | null {
    let active: RunRecord | null = null;
    for (const run of this.runs.values()) {
      if (run.threadId === threadId && !isTerminalRunStatus(run.status)) {
        active = run;
      }
    }
    return active;
  }

  async createRun(input: {
    threadId: string;
    graphId: string;
    multitaskStrategy: MultitaskStrategy;
  }): Promise<RunRecord> {
    const active = this.activeRun(input.threadId);
    const decision = resolveMultitask({
      activeRun: active ? { runId: active.runId, status: active.status } : null,
      strategy: input.multitaskStrategy,
    });

    if (decision.kind === "reject") {
      throw new RunConflictError(decision.activeRunId);
    }
    if (decision.kind === "interrupt") {
      this.transition(decision.supersededRunId, "interrupted");
    }
    if (decision.kind === "rollback") {
      this.transition(decision.discardedRunId, "cancelled");
    }

    const at = this.now();
    const run: RunRecord = {
      runId: this.nextId("run"),
      threadId: input.threadId,
      graphId: input.graphId,
      // `enqueue` waits behind the active run; everything else starts now.
      status: decision.kind === "enqueue" ? "pending" : "running",
      multitaskStrategy: input.multitaskStrategy,
      createdAt: at,
      updatedAt: at,
    };
    this.runs.set(run.runId, run);
    return run;
  }

  async getRun(threadId: string, runId: string): Promise<RunRecord | null> {
    const run = this.runs.get(runId);
    return run && run.threadId === threadId ? run : null;
  }

  async listRuns(threadId: string): Promise<RunRecord[]> {
    return [...this.runs.values()].filter((run) => run.threadId === threadId);
  }

  async cancelRun(threadId: string, runId: string): Promise<RunRecord | null> {
    const run = this.runs.get(runId);
    if (!run || run.threadId !== threadId) {
      return null;
    }
    if (isTerminalRunStatus(run.status)) {
      return run;
    }
    return this.transition(runId, "cancelled");
  }

  async getThreadState(_threadId: string): Promise<unknown> {
    // The in-memory reference runs no graph, so it holds no checkpoint state.
    return null;
  }

  /**
   * Advance a run's status (used by the worker to mark success/error/timeout).
   * Beyond the {@link RunsStore} contract, but part of a full store.
   */
  transition(runId: string, to: AsyncRunStatus): RunRecord {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Unknown run: ${runId}`);
    }
    if (!canTransition(run.status, to)) {
      throw new Error(`Illegal run transition ${run.status} → ${to}`);
    }
    const updated: RunRecord = { ...run, status: to, updatedAt: this.now() };
    this.runs.set(runId, updated);
    return updated;
  }
}
