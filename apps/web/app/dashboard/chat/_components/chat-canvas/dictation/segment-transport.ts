import type { SpeechSegment } from "@sourceweft/ui-web/lib/audio/speech-segmenter";
import { encodeWav } from "@sourceweft/ui-web/lib/audio/wav";

/** What `send` rejects with. `status` is the HTTP status, null for a network failure. */
export class SegmentSendError extends Error {
  constructor(
    readonly status: number | null,
    readonly retryAfterSeconds?: number,
  ) {
    super(`segment send failed with status ${status ?? "network"}`);
    this.name = "SegmentSendError";
  }
}

export type SegmentTransportError = {
  reason: "insufficient-credits" | "unavailable" | "rate-limited" | "failed";
};

export type SegmentTransport = {
  enqueue(segment: SpeechSegment): void;
  /** Enqueued and not yet delivered. */
  pending(): number;
  whenIdle(): Promise<void>;
  /** Drops undelivered segments, cancels requests, delivers nothing more. */
  abort(): void;
};

const MAX_IN_FLIGHT = 2;
const MAX_RETRY_AFTER_SECONDS = 5;

type QueuedSegment = {
  seq: number;
  segment: SpeechSegment;
};

type DeliveredResult =
  | { kind: "text"; text: string; endedBy: SpeechSegment["endedBy"] }
  | { kind: "skip" };

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends enqueued segments in order, at most two at a time, and delivers their
 * text through `onText` strictly in the order segments were enqueued — even
 * when a later segment's response arrives first. A segment that fails is
 * retried once, except for the status codes that never succeed again
 * (insufficient credits, unavailable, invalid audio); a 429 waits out
 * `Retry-After` (capped at 5 s) before its one retry. Once a segment fails
 * for good, `onError` fires once and the transport stops delivering anything
 * else, as if `abort()` had been called.
 */
export function createSegmentTransport(input: {
  send(wav: Uint8Array, seq: number, signal: AbortSignal): Promise<{ text: string }>;
  onText(text: string, segment: { seq: number; endedBy: SpeechSegment["endedBy"] }): void;
  onError(error: SegmentTransportError): void;
  onPendingChange?(pending: number): void;
  wait?(ms: number): Promise<void>;
}): SegmentTransport {
  const wait = input.wait ?? defaultWait;

  const queue: QueuedSegment[] = [];
  const ready = new Map<number, DeliveredResult>();
  const controllers = new Set<AbortController>();
  const idleWaiters: Array<() => void> = [];

  let nextSeq = 0;
  let enqueuedCount = 0;
  let deliveredCount = 0;
  let inFlight = 0;
  let nextToDeliver = 0;
  let aborted = false;

  function pending(): number {
    // Once aborted — by an explicit abort() or a terminal failure — nothing
    // undelivered will ever be delivered, so there is nothing left pending.
    return aborted ? 0 : enqueuedCount - deliveredCount;
  }

  function notifyPending(): void {
    input.onPendingChange?.(pending());
  }

  function settleIdleIfDone(): void {
    if (pending() !== 0 || idleWaiters.length === 0) {
      return;
    }
    const waiters = idleWaiters.splice(0, idleWaiters.length);
    for (const resolve of waiters) {
      resolve();
    }
  }

  function cancelRemaining(): void {
    for (const controller of controllers) {
      controller.abort();
    }
    controllers.clear();
    queue.length = 0;
  }

  /** Marks the transport aborted (idempotent) and settles everything that was waiting on it. */
  function enterAborted(): void {
    if (aborted) {
      return;
    }
    const hadPending = enqueuedCount - deliveredCount !== 0;
    aborted = true;
    cancelRemaining();
    if (hadPending) {
      notifyPending();
    }
    settleIdleIfDone();
  }

  function fail(error: SegmentTransportError): void {
    if (aborted) {
      return;
    }
    enterAborted();
    input.onError(error);
  }

  function deliverReady(): void {
    while (ready.has(nextToDeliver)) {
      const result = ready.get(nextToDeliver)!;
      ready.delete(nextToDeliver);
      const seq = nextToDeliver;
      nextToDeliver += 1;
      deliveredCount += 1;
      if (result.kind === "text") {
        input.onText(result.text, { seq, endedBy: result.endedBy });
      }
      notifyPending();
    }
    settleIdleIfDone();
  }

  function pump(): void {
    if (aborted) {
      return;
    }
    while (inFlight < MAX_IN_FLIGHT && queue.length > 0) {
      const item = queue.shift()!;
      inFlight += 1;
      void runSend(item);
    }
  }

  async function runSend(item: QueuedSegment): Promise<void> {
    const wav = encodeWav(item.segment.samples);
    const controller = new AbortController();
    controllers.add(controller);

    const settle = (outcome: { text: string } | { reason: SegmentTransportError["reason"] }) => {
      controllers.delete(controller);
      inFlight -= 1;
      if (aborted || controller.signal.aborted) {
        return;
      }
      if ("reason" in outcome) {
        fail({ reason: outcome.reason });
        return;
      }
      ready.set(
        item.seq,
        outcome.text.length === 0
          ? { kind: "skip" }
          : { kind: "text", text: outcome.text, endedBy: item.segment.endedBy },
      );
      deliverReady();
      pump();
    };

    try {
      const result = await input.send(wav, item.seq, controller.signal);
      settle({ text: result.text });
      return;
    } catch (error) {
      if (aborted || controller.signal.aborted) {
        return;
      }

      const status = error instanceof SegmentSendError ? error.status : null;
      const retryAfterSeconds =
        error instanceof SegmentSendError ? error.retryAfterSeconds : undefined;

      if (status === 402) {
        settle({ reason: "insufficient-credits" });
        return;
      }
      if (status === 404) {
        settle({ reason: "unavailable" });
        return;
      }
      if (status === 400) {
        settle({ reason: "failed" });
        return;
      }

      if (status === 429) {
        const delaySeconds = Math.min(
          retryAfterSeconds ?? MAX_RETRY_AFTER_SECONDS,
          MAX_RETRY_AFTER_SECONDS,
        );
        await wait(delaySeconds * 1000);
        if (aborted || controller.signal.aborted) {
          return;
        }
        try {
          const retryResult = await input.send(wav, item.seq, controller.signal);
          settle({ text: retryResult.text });
        } catch {
          settle({ reason: "rate-limited" });
        }
        return;
      }

      // Any other failure (network error or an unexpected status): one retry.
      try {
        const retryResult = await input.send(wav, item.seq, controller.signal);
        settle({ text: retryResult.text });
      } catch {
        settle({ reason: "failed" });
      }
    }
  }

  return {
    enqueue(segment: SpeechSegment): void {
      if (aborted) {
        return;
      }
      const seq = nextSeq;
      nextSeq += 1;
      enqueuedCount += 1;
      queue.push({ seq, segment });
      notifyPending();
      pump();
    },
    pending,
    whenIdle(): Promise<void> {
      if (pending() === 0) {
        return Promise.resolve();
      }
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    abort(): void {
      enterAborted();
    },
  };
}
