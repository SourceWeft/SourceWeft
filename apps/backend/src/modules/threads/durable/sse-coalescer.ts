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
 * Successful slow writes extend the next collection window to at most one
 * second; cheap writes retain the 80 ms cadence. Accumulated deltas also flush
 * at 4096 UTF-16 characters. No timer is introduced: incoming events and the
 * caller's boundaries/end flush continue to drive persistence.
 *
 * Only the persistence cadence changes. The in-memory snapshot is still updated
 * per raw event by the caller, and a client applies a windowed delta exactly as
 * it applies the token-sized ones: text is appended, a reasoning segment is
 * upserted by its id with the latest `segment` fields.
 */

export const STREAM_APPEND_DELTA_FLUSH_MS = 80;
const MAX_DELTA_FLUSH_MS = 1000;
const MAX_BUFFERED_DELTA_CHARS = 4096;

type Payload = Record<string, unknown>;

export function isTextDeltaPayload(
  payload: Payload | null,
): payload is Payload & { type: "text-delta"; delta: string } {
  return payload?.type === "text-delta" && typeof payload.delta === "string";
}

export function isReasoningDeltaPayload(
  payload: Payload | null,
): payload is Payload & {
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
      isReasoningDeltaPayload(payload) &&
      payload.segment.id === pending.segment.id
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

function deltaCharacters(payload: Payload) {
  if (isTextDeltaPayload(payload)) return payload.delta.length;
  if (isReasoningDeltaPayload(payload)) return payload.reasoning.length;
  return 0;
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
  let pendingCharacters = 0;
  let collectionWindowMs = flushMs;

  const flush = async () => {
    if (!pending) {
      return;
    }
    const payload = pending;
    pending = null;
    pendingStartedAt = 0;
    pendingCharacters = 0;
    const flushStartedAt = now();
    await input.flush(payload);
    // Measure only a successful persistence. Start the next collection window
    // with its first delta, after this write completes, rather than charging
    // this write's latency against that new window.
    collectionWindowMs = Math.max(
      flushMs,
      Math.min(MAX_DELTA_FLUSH_MS, now() - flushStartedAt),
    );
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
    const characters = deltaCharacters(payload!);
    if (pending && pendingCharacters + characters > MAX_BUFFERED_DELTA_CHARS) {
      await flush();
    }
    if (!pending) {
      pending = { ...payload! };
      pendingCharacters = characters;
      pendingStartedAt = now();
      // One oversized raw event is persisted unchanged, never split or merged
      // with other events. Across raw events, accumulated text stays bounded.
      if (pendingCharacters >= MAX_BUFFERED_DELTA_CHARS) await flush();
      return true;
    }
    pending = mergeDelta(pending, payload!);
    pendingCharacters += characters;
    if (
      pendingCharacters >= MAX_BUFFERED_DELTA_CHARS ||
      now() - pendingStartedAt >= collectionWindowMs
    ) {
      await flush();
    }
    return true;
  };

  return { push, flush };
}
