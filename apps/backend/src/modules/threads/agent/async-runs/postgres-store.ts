/**
 * Postgres-backed {@link RunsStore}. Mirrors {@link InMemoryRunsStore} exactly —
 * same state machine + multitask resolver — swapping the maps for rows. Uses raw
 * parameterized SQL over an injected `pg` Pool and creates its own tables
 * (`IF NOT EXISTS`), so it does not depend on the shared drizzle schema.
 *
 * Run execution (BullMQ job) and thread checkpoint state are wired separately;
 * this store owns only the durable run/thread records and their lifecycle.
 */
import type { Pool } from "pg";
import type {
  AsyncRunStatus,
  MultitaskStrategy,
  RunRecord,
  RunsStore,
  ThreadRecord,
} from "./types";
import { canTransition, isTerminalRunStatus, resolveMultitask } from "./run-state";
import { RunConflictError } from "./in-memory-store";

const TERMINAL = ["success", "error", "timeout", "cancelled", "interrupted"];

interface RunRow {
  run_id: string;
  thread_id: string;
  graph_id: string;
  status: AsyncRunStatus;
  multitask_strategy: MultitaskStrategy;
  created_at: Date;
  updated_at: Date;
}

function rowToRun(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    threadId: row.thread_id,
    graphId: row.graph_id,
    status: row.status,
    multitaskStrategy: row.multitask_strategy,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PostgresRunsStore implements RunsStore {
  constructor(private readonly pool: Pool) {}

  /** Idempotent schema bootstrap. Call once before use. */
  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS async_threads (
        thread_id  text PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS async_runs (
        seq                bigserial,
        run_id             text PRIMARY KEY,
        thread_id          text NOT NULL,
        graph_id           text NOT NULL,
        status             text NOT NULL,
        multitask_strategy text NOT NULL,
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS async_runs_thread_seq_idx
        ON async_runs (thread_id, seq);
    `);
  }

  async createThread(): Promise<ThreadRecord> {
    const threadId = `thread_${crypto.randomUUID()}`;
    const { rows } = await this.pool.query<{ thread_id: string; created_at: Date }>(
      `INSERT INTO async_threads (thread_id) VALUES ($1)
       RETURNING thread_id, created_at`,
      [threadId],
    );
    return {
      threadId: rows[0]!.thread_id,
      createdAt: rows[0]!.created_at.toISOString(),
    };
  }

  /** Newest non-terminal run on the thread, by insertion order (seq). */
  private async activeRun(threadId: string): Promise<RunRecord | null> {
    const { rows } = await this.pool.query<RunRow>(
      `SELECT * FROM async_runs
        WHERE thread_id = $1 AND NOT (status = ANY($2))
        ORDER BY seq DESC LIMIT 1`,
      [threadId, TERMINAL],
    );
    return rows[0] ? rowToRun(rows[0]) : null;
  }

  async createRun(input: {
    threadId: string;
    graphId: string;
    multitaskStrategy: MultitaskStrategy;
  }): Promise<RunRecord> {
    const active = await this.activeRun(input.threadId);
    const decision = resolveMultitask({
      activeRun: active ? { runId: active.runId, status: active.status } : null,
      strategy: input.multitaskStrategy,
    });

    if (decision.kind === "reject") {
      throw new RunConflictError(decision.activeRunId);
    }
    if (decision.kind === "interrupt") {
      await this.transition(decision.supersededRunId, "interrupted");
    }
    if (decision.kind === "rollback") {
      await this.transition(decision.discardedRunId, "cancelled");
    }

    const runId = `run_${crypto.randomUUID()}`;
    const status: AsyncRunStatus =
      decision.kind === "enqueue" ? "pending" : "running";
    const { rows } = await this.pool.query<RunRow>(
      `INSERT INTO async_runs (run_id, thread_id, graph_id, status, multitask_strategy)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [runId, input.threadId, input.graphId, status, input.multitaskStrategy],
    );
    return rowToRun(rows[0]!);
  }

  async getRun(threadId: string, runId: string): Promise<RunRecord | null> {
    const { rows } = await this.pool.query<RunRow>(
      `SELECT * FROM async_runs WHERE run_id = $1 AND thread_id = $2`,
      [runId, threadId],
    );
    return rows[0] ? rowToRun(rows[0]) : null;
  }

  async listRuns(threadId: string): Promise<RunRecord[]> {
    const { rows } = await this.pool.query<RunRow>(
      `SELECT * FROM async_runs WHERE thread_id = $1 ORDER BY seq`,
      [threadId],
    );
    return rows.map(rowToRun);
  }

  async cancelRun(threadId: string, runId: string): Promise<RunRecord | null> {
    const run = await this.getRun(threadId, runId);
    if (!run) {
      return null;
    }
    if (isTerminalRunStatus(run.status)) {
      return run;
    }
    return this.transition(runId, "cancelled");
  }

  async getThreadState(_threadId: string): Promise<unknown> {
    // Checkpoint state is owned by the PostgresSaver keyed on the run's graph
    // thread; wired with the processor. Null until then.
    return null;
  }

  /** Guarded status advance (used by the worker to mark success/error/timeout). */
  async transition(runId: string, to: AsyncRunStatus): Promise<RunRecord> {
    const { rows } = await this.pool.query<RunRow>(
      `SELECT * FROM async_runs WHERE run_id = $1`,
      [runId],
    );
    const current = rows[0];
    if (!current) {
      throw new Error(`Unknown run: ${runId}`);
    }
    if (!canTransition(current.status, to)) {
      throw new Error(`Illegal run transition ${current.status} → ${to}`);
    }
    const { rows: updated } = await this.pool.query<RunRow>(
      `UPDATE async_runs SET status = $2, updated_at = now()
        WHERE run_id = $1 RETURNING *`,
      [runId, to],
    );
    return rowToRun(updated[0]!);
  }

  /** Test/maintenance helper: remove a thread and its runs. */
  async deleteThread(threadId: string): Promise<void> {
    await this.pool.query(`DELETE FROM async_runs WHERE thread_id = $1`, [
      threadId,
    ]);
    await this.pool.query(`DELETE FROM async_threads WHERE thread_id = $1`, [
      threadId,
    ]);
  }
}
