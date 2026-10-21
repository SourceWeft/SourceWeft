import type { ActiveThreadRun } from "../chat-stream-runner-control";

// Recovery for a failed attach-only stream (the page re-attaching to a durable
// run after a reload). The run keeps executing server-side, so a transport
// failure must neither drop the local active run (Stop would vanish) nor leave
// the UI "executing" forever after the run ends. Each failure reconciles with
// the server's active run after a bounded exponential backoff and either
// re-attaches (same run still active) or settles the ended run. These are code
// constants on purpose: they bound a client retry loop, not deployment intent.
export const ATTACH_REATTACH_MAX_ATTEMPTS = 4;
export const ATTACH_REATTACH_BASE_DELAY_MS = 1_000;
export const ATTACH_REATTACH_MAX_DELAY_MS = 8_000;

/** Delay before the given 1-based reattach attempt: 1s, 2s, 4s, 8s (capped). */
export function resolveAttachReattachDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(
    ATTACH_REATTACH_BASE_DELAY_MS * 2 ** exponent,
    ATTACH_REATTACH_MAX_DELAY_MS,
  );
}

export type AttachFailureOutcome =
  // A reconcile/re-attach is now scheduled for this run.
  | "scheduled"
  // One is already pending for this run; this failure adds nothing.
  | "pending"
  // The attempt cap is reached; recovery gave up (onGiveUp was called).
  | "exhausted"
  // The run is no longer the local active run (stopped, replaced, cleared).
  | "ignored";

export type AttachReattachDeps = {
  /** The server's active run for the thread, or null when none is active. */
  getActiveRun: () => Promise<ActiveThreadRun | null>;
  /** Whether `runKey` is still the local active run and not being stopped. */
  isRunCurrent: (runKey: string) => boolean;
  /**
   * The same run is still active server-side: re-attach to it. Resolving to
   * false means the re-attach could not even start (e.g. the reload failed);
   * that spends another attempt. A started attach reports its own outcome
   * through handleAttachFailure / noteAttachSucceeded.
   */
  reattach: (run: ActiveThreadRun) => void | boolean | Promise<boolean>;
  /** The run is no longer active server-side: clear it and settle the UI. */
  settleEndedRun: (runKey: string) => void;
  /** Recovery stopped after the attempt cap; the active run is left as-is. */
  onGiveUp: (runKey: string, error: unknown) => void;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export type AttachReattachScheduler = {
  handleAttachFailure: (runKey: string, error: unknown) => AttachFailureOutcome;
  /** A stream is starting: a new (non-attach) run cancels all recovery. */
  noteStreamStart: (runKey: string, attachOnly: boolean) => void;
  /** An attach stream for `runKey` ended without a transport failure. */
  noteAttachSucceeded: (runKey: string) => void;
  /**
   * An attach stream for `runKey` received its first event: the connection
   * works again, so the next failure streak gets a fresh attempt budget.
   */
  noteAttachProgress: (runKey: string) => void;
  /** Cancel every pending reattach and forget attempt counts. */
  cancelAll: () => void;
  hasPending: (runKey: string) => boolean;
};

type PendingEntry = {
  timer: unknown;
  cancelled: boolean;
};

export function createAttachReattachScheduler(
  deps: AttachReattachDeps,
): AttachReattachScheduler {
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer =
    deps.clearTimer ??
    ((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
  const attemptsByRunKey = new Map<string, number>();
  const pendingByRunKey = new Map<string, PendingEntry>();
  // Bumped by every cancellation that is not tied to a pending entry, so an
  // awaited reattach that resolves afterwards cannot schedule a stale retry.
  let epoch = 0;
  const lastErrorByRunKey = new Map<string, unknown>();

  const cancelPending = (runKey: string) => {
    const entry = pendingByRunKey.get(runKey);
    if (!entry) return;
    entry.cancelled = true;
    if (entry.timer !== null) clearTimer(entry.timer);
    pendingByRunKey.delete(runKey);
  };

  const cancelAllPending = () => {
    for (const runKey of [...pendingByRunKey.keys()]) cancelPending(runKey);
  };

  const reconcile = async (runKey: string, entry: PendingEntry) => {
    entry.timer = null;
    let serverRun: ActiveThreadRun | null;
    try {
      serverRun = await deps.getActiveRun();
    } catch (error) {
      if (entry.cancelled) return;
      pendingByRunKey.delete(runKey);
      // The reconcile read itself failed (still offline): spend another
      // attempt rather than guessing the run's state.
      schedule(runKey, error);
      return;
    }
    if (entry.cancelled) return;
    pendingByRunKey.delete(runKey);
    // Stopped, replaced by a new run, or cleared by another path while we
    // waited: whoever changed it owns the UI now.
    if (!deps.isRunCurrent(runKey)) return;
    if (serverRun?.idempotencyKey === runKey) {
      const startEpoch = epoch;
      let started: boolean;
      let reattachError: unknown = lastErrorByRunKey.get(runKey);
      try {
        started = (await deps.reattach(serverRun)) !== false;
      } catch (error) {
        started = false;
        reattachError = error;
      }
      if (
        started ||
        epoch !== startEpoch ||
        pendingByRunKey.has(runKey) ||
        !deps.isRunCurrent(runKey)
      ) {
        return;
      }
      schedule(runKey, reattachError);
      return;
    }
    attemptsByRunKey.delete(runKey);
    lastErrorByRunKey.delete(runKey);
    deps.settleEndedRun(runKey);
  };

  const schedule = (runKey: string, error: unknown): AttachFailureOutcome => {
    lastErrorByRunKey.set(runKey, error);
    const attempt = (attemptsByRunKey.get(runKey) ?? 0) + 1;
    if (attempt > ATTACH_REATTACH_MAX_ATTEMPTS) {
      deps.onGiveUp(runKey, error);
      return "exhausted";
    }
    attemptsByRunKey.set(runKey, attempt);
    const entry: PendingEntry = { timer: null, cancelled: false };
    pendingByRunKey.set(runKey, entry);
    entry.timer = setTimer(() => {
      void reconcile(runKey, entry);
    }, resolveAttachReattachDelayMs(attempt));
    return "scheduled";
  };

  return {
    handleAttachFailure(runKey, error) {
      if (pendingByRunKey.has(runKey)) return "pending";
      if (!deps.isRunCurrent(runKey)) return "ignored";
      return schedule(runKey, error);
    },
    noteStreamStart(runKey, attachOnly) {
      if (!attachOnly) {
        epoch += 1;
        cancelAllPending();
        attemptsByRunKey.clear();
        lastErrorByRunKey.clear();
        return;
      }
      // An attach is starting now (the reattach itself, or the reload path):
      // it supersedes any pending reattach. Attempt counts survive so a
      // failing run stays bounded across these attaches.
      cancelAllPending();
      for (const key of [...attemptsByRunKey.keys()]) {
        if (key !== runKey) attemptsByRunKey.delete(key);
      }
    },
    noteAttachSucceeded(runKey) {
      cancelPending(runKey);
      attemptsByRunKey.delete(runKey);
      lastErrorByRunKey.delete(runKey);
    },
    noteAttachProgress(runKey) {
      attemptsByRunKey.delete(runKey);
    },
    cancelAll() {
      epoch += 1;
      cancelAllPending();
      attemptsByRunKey.clear();
      lastErrorByRunKey.clear();
    },
    hasPending(runKey) {
      return pendingByRunKey.has(runKey);
    },
  };
}
