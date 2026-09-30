/**
 * Windows consecutive streamed deltas into one persisted SSE event.
 *
 * Every event appended to a durable run costs a heartbeat, a Redis append and a
 * transaction that rewrites the run's snapshot, and the snapshot grows with the
 * turn. A model streams a token at a time, so persisting each token as its own
 * event turns a six-second answer into minutes of writes: measured on a
 * reasoning model, 1,356 `reasoning` events took 116 s to persist while the
 * model itself was done in 6 s. Text deltas were already windowed; reasoning
 * deltas were not.
 *
 * Only the persistence cadence changes. The in-memory snapshot is still updated
 * per raw event by the caller, and a client applies a windowed delta exactly as
 * it applies the token-sized ones: text is appended, a reasoning segment is
 * upserted by its id with the latest `segment` fields.
 */

export const STREAM_APPEND_DELTA_FLUSH_MS = 80;

type Payload = Record<string, unknown>;

export function isTextDeltaPayload(
  payload: Payload | null,
): payload is Payload & { type: "text-delta"; delta: string } {
  return payload?.type === "text-delta" && typeof payload.delta === "string";
}

export function isReasoningDeltaPayload(payload: Payload | null): payload is Payload & {
  type: "reasoning";
  reasoning: string;
  segment: Payload & { id: string };
} {
  if (payload?.type !== "reasoning" || typeof payload.reasoning !== "string") {
    return false;
  }
  const segment = payload.segment;
  return (
    typeof segment === "object" &&
    segment !== null &&
    !Array.isArray(segment) &&
    typeof (segment as Payload).id === "string"
  );
}

function continuesPending(pending: Payload, payload: Payload) {
  if (isTextDeltaPayload(pending)) {
    return isTextDeltaPayload(payload);
  }
  if (isReasoningDeltaPayload(pending)) {
    return (
      isReasoningDeltaPayload(payload) && payload.segment.id === pending.segment.id
    );
  }
  return false;
}

function mergeDelta(pending: Payload, payload: Payload): Payload {
  if (isTextDeltaPayload(pending) && isTextDeltaPayload(payload)) {
    return { ...pending, delta: `${pending.delta}${payload.delta}` };
  }
  if (isReasoningDeltaPayload(pending) && isReasoningDeltaPayload(payload)) {
    // The latest segment carries the running duration.
    return {
      ...pending,
      reasoning: `${pending.reasoning}${payload.reasoning}`,
      segment: payload.segment,
    };
  }
  return payload;
}

export function createDeltaCoalescer(input: {
  /** Persists one (possibly merged) delta payload. */
  flush: (payload: Payload) => Promise<void>;
  flushMs?: number;
  now?: () => number;
}) {
  const flushMs = input.flushMs ?? STREAM_APPEND_DELTA_FLUSH_MS;
  const now = input.now ?? Date.now;
  let pending: Payload | null = null;
  let pendingStartedAt = 0;

  const flush = async () => {
    if (!pending) {
      return;
    }
    const payload = pending;
    pending = null;
    pendingStartedAt = 0;
    await input.flush(payload);
  };

  /**
   * Offers one parsed payload. Returns true when the coalescer took it (it was
   * buffered, or flushed as part of a window); false when it is not a delta,
   * in which case whatever was pending has been flushed first, in order, and
   * the caller appends the event itself.
   */
  const push = async (payload: Payload | null): Promise<boolean> => {
    const isDelta =
      isTextDeltaPayload(payload) || isReasoningDeltaPayload(payload);
    if (pending && (!isDelta || !continuesPending(pending, payload!))) {
      await flush();
    }
    if (!isDelta) {
      return false;
    }
    if (!pending) {
      pending = { ...payload! };
      pendingStartedAt = now();
      return true;
    }
    pending = mergeDelta(pending, payload!);
    if (now() - pendingStartedAt >= flushMs) {
      await flush();
    }
    return true;
  };

  return { push, flush };
}
