/**
 * The async-run state machine and multitask (double-texting) resolver.
 *
 * These are the two pieces the LangGraph Server provides that a self-hosted
 * endpoint must re-implement (the only functional deltas): a run-status
 * lifecycle, and the policy for a new run arriving while one is in flight.
 * Both are pure so they can be unit-tested without BullMQ/Postgres.
 */
import type { AsyncRunStatus, MultitaskStrategy } from "./types";

/** Statuses a run can never leave. */
export const TERMINAL_RUN_STATUSES: ReadonlySet<AsyncRunStatus> = new Set<AsyncRunStatus>(
  ["success", "error", "timeout", "cancelled", "interrupted"],
);

export function isTerminalRunStatus(status: AsyncRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

const ALLOWED_TRANSITIONS: Readonly<Record<AsyncRunStatus, ReadonlySet<AsyncRunStatus>>> =
  {
    pending: new Set<AsyncRunStatus>([
      "running",
      "cancelled",
      "interrupted",
    ]),
    running: new Set<AsyncRunStatus>([
      "success",
      "error",
      "timeout",
      "cancelled",
      "interrupted",
    ]),
    success: new Set<AsyncRunStatus>(),
    error: new Set<AsyncRunStatus>(),
    timeout: new Set<AsyncRunStatus>(),
    cancelled: new Set<AsyncRunStatus>(),
    interrupted: new Set<AsyncRunStatus>(),
  };

/** Whether a run may move `from → to`. Terminal statuses never transition. */
export function canTransition(
  from: AsyncRunStatus,
  to: AsyncRunStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].has(to);
}

/** What to do with an incoming run given the thread's active run + strategy. */
export type MultitaskDecision =
  /** No active run — start immediately. */
  | { kind: "start" }
  /** Reject the new run; the active one keeps going. */
  | { kind: "reject"; activeRunId: string }
  /** Cancel the active run, then start the new one (deepagents' update path). */
  | { kind: "interrupt"; supersededRunId: string }
  /** Discard the active run's effects, then start the new one. */
  | { kind: "rollback"; discardedRunId: string }
  /** Queue the new run behind the active one. */
  | { kind: "enqueue"; afterRunId: string };

/**
 * Resolve the double-texting policy. An active run is one that is not terminal;
 * if the thread's latest run is already terminal, the incoming run always
 * starts regardless of strategy.
 */
export function resolveMultitask(input: {
  activeRun: { runId: string; status: AsyncRunStatus } | null;
  strategy: MultitaskStrategy;
}): MultitaskDecision {
  const { activeRun, strategy } = input;
  if (!activeRun || isTerminalRunStatus(activeRun.status)) {
    return { kind: "start" };
  }
  switch (strategy) {
    case "reject":
      return { kind: "reject", activeRunId: activeRun.runId };
    case "interrupt":
      return { kind: "interrupt", supersededRunId: activeRun.runId };
    case "rollback":
      return { kind: "rollback", discardedRunId: activeRun.runId };
    case "enqueue":
      return { kind: "enqueue", afterRunId: activeRun.runId };
  }
}
