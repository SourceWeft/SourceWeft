import { ContentError } from "../content/errors";

/**
 * `throwIfClientCancelled` (in the stream service) recognizes this code and
 * treats the turn as cancelled rather than failed, so a gate that trips
 * mid-write unwinds into the same terminal path as a cancel caught between
 * events.
 */
const CLIENT_CANCELLED_CODE = "CLIENT_CANCELLED";

/**
 * The host's cancellation gate for a single turn.
 *
 * A capability's write reaches persistence through the host services bag; the
 * gate is the host's chance to refuse that write once the run has been
 * cancelled. It closes the window that let an in-flight tool (a deck render, an
 * image, a file) persist its output *after* the user pressed Stop: the stream
 * loop only polls cancellation between agent events, so a tool that is already
 * executing when the stop arrives runs to completion and commits before the
 * next checkpoint is ever reached.
 *
 * P0 checks the live run status — the same poll the stream loop uses — at the
 * moment of the write, which is why it catches a cancel that landed while the
 * tool was running. A later phase can additionally observe an `AbortSignal` so
 * the gate trips the instant a cancel arrives rather than at the next write.
 */
export type RunCancellationGate = {
  /**
   * Rejects with a `CLIENT_CANCELLED` {@link ContentError} when the run is no
   * longer live. `action` names the write being guarded so the message reads as
   * "cancelled before publishing the artifact".
   */
  throwIfCancelled(action?: string): Promise<void>;
};

export function createRunCancellationGate(source: {
  shouldCancel?: () => Promise<boolean>;
  signal?: AbortSignal;
}): RunCancellationGate {
  return {
    async throwIfCancelled(action) {
      const cancelled =
        source.signal?.aborted === true ||
        (await source.shouldCancel?.()) === true;
      if (!cancelled) {
        return;
      }
      throw new ContentError(
        499,
        CLIENT_CANCELLED_CODE,
        action
          ? `Chat run was cancelled before ${action}`
          : "Chat run was cancelled",
      );
    },
  };
}

/**
 * Wraps an async write so it refuses to run once the turn is cancelled, while
 * preserving the wrapped function's exact signature — which the host services
 * bag is annotated against, so the wrapper must stay assignable to the contract
 * type. Returns `fn` unchanged when no gate is wired (tests and the non-durable
 * paths), keeping today's behavior there.
 */
export function guardCancellableWrite<A extends unknown[], R>(
  gate: RunCancellationGate | undefined,
  action: string,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  if (!gate) {
    return fn;
  }
  return async (...args: A) => {
    await gate.throwIfCancelled(action);
    return fn(...args);
  };
}
