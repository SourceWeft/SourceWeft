/**
 * Drives one run through its execution lifecycle. The BullMQ worker calls this;
 * the graph execution is injected as a {@link RunExecutor} so the lifecycle is
 * testable against the real store without the full agent assembly.
 *
 * Correctly handles a run that was interrupted/cancelled concurrently (e.g. a
 * newer run arriving with `multitask_strategy: "interrupt"`): it never forces a
 * terminal run back to `success`.
 */
import type { AsyncRunStatus, RunRecord } from "./types";
import { isTerminalRunStatus } from "./run-state";

/**
 * Executes a run's delegate graph. Resolves with the graph's final state on
 * completion (persisted so `check_async_task` can read the result); throws on
 * failure.
 */
export type RunExecutor = (
  run: RunRecord,
  signal: AbortSignal,
) => Promise<unknown>;

/** The subset of the store the processor needs. */
export interface RunLifecycleStore {
  getRun(threadId: string, runId: string): Promise<RunRecord | null>;
  transition(runId: string, to: AsyncRunStatus): Promise<RunRecord>;
  /** Persist a completed run's final graph state (thread-scoped). Optional. */
  saveResult?(threadId: string, runId: string, values: unknown): Promise<void>;
}

export async function processRun(input: {
  store: RunLifecycleStore;
  executor: RunExecutor;
  threadId: string;
  runId: string;
  signal?: AbortSignal;
}): Promise<AsyncRunStatus> {
  const { store, executor, threadId, runId } = input;
  const signal = input.signal ?? new AbortController().signal;

  const run = await store.getRun(threadId, runId);
  if (!run) {
    throw new Error(`Unknown run: ${runId}`);
  }
  // Interrupted/cancelled before pickup — nothing to run.
  if (isTerminalRunStatus(run.status)) {
    return run.status;
  }
  if (signal.aborted) {
    return (await store.transition(runId, "cancelled")).status;
  }

  // Promote a queued run; a `running` run proceeds as-is.
  const active =
    run.status === "running" ? run : await store.transition(runId, "running");

  let values: unknown;
  try {
    values = await executor(active, signal);
  } catch {
    // A concurrent interrupt/cancel wins over a late failure.
    const after = await store.getRun(threadId, runId);
    if (after && isTerminalRunStatus(after.status)) {
      return after.status;
    }
    if (signal.aborted) {
      return (await store.transition(runId, "cancelled")).status;
    }
    return (await store.transition(runId, "error")).status;
  }

  // Completed — unless it was superseded/cancelled mid-flight.
  const after = await store.getRun(threadId, runId);
  if (after && isTerminalRunStatus(after.status)) {
    return after.status;
  }
  // Persist the final state BEFORE marking success, so a reader that sees
  // `success` is guaranteed to find the result (durable in the store, not memory).
  await store.saveResult?.(threadId, runId, values);
  return (await store.transition(runId, "success")).status;
}
