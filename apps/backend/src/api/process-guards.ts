/**
 * Last-resort handling for errors nothing caught, in the API process.
 *
 * The two events are NOT treated alike, because they mean different things:
 *
 * - `unhandledRejection` — some promise was rejected and nobody was awaiting
 *   it. That is almost always scoped to the one request (or library internals)
 *   that created it; the process itself is fine. Node's default is to exit,
 *   which once turned a single failed tool call — a connection reset on the
 *   way to the sandbox provider — into an outage for every user. It is logged
 *   loudly, counted, and the process keeps serving.
 *
 * - `uncaughtException` — a synchronous throw escaped every handler. Node's
 *   guidance holds: the process may be in an undefined state, so it must not
 *   carry on. It stops taking new work, lets what is in flight finish for a
 *   bounded time, and exits non-zero for the supervisor to restart it.
 */

/** How long in-flight requests get to finish before the exit is forced. */
export const API_DRAIN_TIMEOUT_MS = 10_000;

type GuardLogger = {
  error: (message: string, meta?: Record<string, unknown>) => void;
};

export type ApiProcessGuardInput = {
  logger: GuardLogger;
  /** Counts occurrences so an alert can watch the rate. */
  count: (
    name: "process.unhandled_rejection" | "process.uncaught_exception",
  ) => void;
  /** Stop accepting work and release resources; must not exit by itself. */
  drain: () => Promise<unknown>;
  exit: (code: number) => void;
  drainTimeoutMs?: number;
};

function describe(reason: unknown) {
  if (reason instanceof Error) {
    const code = (reason as { code?: unknown }).code;
    return {
      errorName: reason.name,
      error: reason.message,
      ...(typeof code === "string" ? { errorCode: code } : {}),
      stack: reason.stack,
    };
  }
  return { errorName: "NonError", error: String(reason) };
}

export function createApiProcessGuards(input: ApiProcessGuardInput) {
  let draining = false;

  function onUnhandledRejection(reason: unknown) {
    input.count("process.unhandled_rejection");
    input.logger.error(
      "Unhandled promise rejection — the process keeps serving",
      describe(reason),
    );
  }

  function onUncaughtException(error: unknown) {
    input.count("process.uncaught_exception");
    if (draining) {
      // A second one while shutting down: the drain itself cannot be trusted.
      input.logger.error(
        "Uncaught exception during shutdown — exiting now",
        describe(error),
      );
      input.exit(1);
      return;
    }
    draining = true;
    input.logger.error(
      "Uncaught exception — draining, then exiting for a restart",
      describe(error),
    );
    const timeoutMs = input.drainTimeoutMs ?? API_DRAIN_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    void Promise.race([
      Promise.resolve()
        .then(() => input.drain())
        .catch((drainError: unknown) => {
          input.logger.error("Drain failed", describe(drainError));
        }),
      deadline,
    ]).finally(() => {
      if (timer) clearTimeout(timer);
      input.exit(1);
    });
  }

  return { onUnhandledRejection, onUncaughtException };
}

export function installApiProcessGuards(input: ApiProcessGuardInput) {
  const guards = createApiProcessGuards(input);
  process.on("unhandledRejection", guards.onUnhandledRejection);
  process.on("uncaughtException", guards.onUncaughtException);
  return () => {
    process.off("unhandledRejection", guards.onUnhandledRejection);
    process.off("uncaughtException", guards.onUncaughtException);
  };
}
