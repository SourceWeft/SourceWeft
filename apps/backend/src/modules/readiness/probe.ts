/**
 * Readiness for an external monitor (Issue #767): a few named checks, each
 * under its own time budget, reported with how long each took.
 *
 * Runs inside the process it reports on. It can therefore say that the
 * database or a read is slow or failing, and a short event-loop stall shows
 * up as a check over its budget; a process whose event loop is fully stalled
 * cannot answer at all, and only the caller's own request timeout sees that.
 */

export type ReadinessCheck = {
  name: string;
  /** The check fails when it has not finished after this long. */
  budgetMs: number;
  run: () => Promise<unknown>;
};

export type ReadinessFailureReason = "error" | "timeout";

export type ReadinessCheckResult = {
  status: "ok" | "failed";
  durationMs: number;
  budgetMs: number;
  /** Only on a failed check. Never the error's own text. */
  reason?: ReadinessFailureReason;
};

export type ReadinessReport = {
  status: "ok" | "unavailable";
  /** Names of the failed checks, in the order the checks are declared. */
  failed: string[];
  checks: Record<string, ReadinessCheckResult>;
  timestamp: string;
};

export type ReadinessProbe = { run: () => Promise<ReadinessReport> };

type ProbeOptions = {
  /** Told about each failure, for the server's own log. */
  onFailure?: (failure: {
    check: string;
    reason: ReadinessFailureReason;
    durationMs: number;
    error?: unknown;
  }) => void;
  now?: () => number;
};

export function createReadinessProbe(
  checks: readonly ReadinessCheck[],
  options: ProbeOptions = {},
): ReadinessProbe {
  const now = options.now ?? (() => performance.now());
  let inFlight: Promise<ReadinessReport> | null = null;
  // Work that outlived its budget and has not settled yet, by check name, with
  // when it started. A query cannot be taken back once sent, so while it is
  // still out no second one is started behind it: a slow database gets one
  // probe query at a time however often the endpoint is called.
  const overdue = new Map<string, number>();

  async function runCheck(check: ReadinessCheck): Promise<ReadinessCheckResult> {
    const fail = (
      reason: ReadinessFailureReason,
      durationMs: number,
      error?: unknown,
    ): ReadinessCheckResult => {
      options.onFailure?.({ check: check.name, reason, durationMs, error });
      return { status: "failed", reason, durationMs, budgetMs: check.budgetMs };
    };

    const overdueSince = overdue.get(check.name);
    if (overdueSince !== undefined) {
      return fail("timeout", Math.round(now() - overdueSince));
    }

    const startedAt = now();
    // Inside a promise chain, so a check that throws synchronously is a
    // failed check, not a failed probe.
    const work = Promise.resolve().then(() => check.run());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      work.then(
        () => ({ kind: "done" as const }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), check.budgetMs);
      }),
    ]);
    clearTimeout(timer);
    const durationMs = Math.round(now() - startedAt);

    if (outcome.kind === "timeout") {
      overdue.set(check.name, startedAt);
      void work
        .catch(() => undefined)
        .finally(() => overdue.delete(check.name));
      return fail("timeout", durationMs);
    }
    if (outcome.kind === "error") {
      return fail("error", durationMs, outcome.error);
    }
    // Finished, but late: after a stall the work and its timer can become
    // due together, and the budget decides, not which callback ran first.
    if (durationMs > check.budgetMs) {
      return fail("timeout", durationMs);
    }
    return { status: "ok", durationMs, budgetMs: check.budgetMs };
  }

  async function runAll(): Promise<ReadinessReport> {
    const results = await Promise.all(checks.map(runCheck));
    const failed = checks
      .filter((_, index) => results[index]!.status === "failed")
      .map((check) => check.name);
    return {
      status: failed.length === 0 ? "ok" : "unavailable",
      failed,
      checks: Object.fromEntries(
        checks.map((check, index) => [check.name, results[index]!]),
      ),
      timestamp: new Date().toISOString(),
    };
  }

  return {
    // Calls that arrive while a run is under way share it and its answer.
    run() {
      inFlight ??= runAll().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}
