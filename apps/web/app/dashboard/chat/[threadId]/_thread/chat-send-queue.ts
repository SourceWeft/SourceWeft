import type { ChatSendInput } from "../../_components/chat-canvas";
import type { ChatExecutionState } from "../chat-stream-runner-control";

/**
 * A message the user submitted while a run was streaming on the thread. It is
 * parked here and auto-sent when the thread returns to idle (client-orchestrated
 * turn-taking). The server stays one-run-per-thread; this queue is what turns
 * its 409 backstop into a smooth "send now, runs next".
 */
export type QueuedSend = {
  id: string;
  input: ChatSendInput;
  // Stable server idempotency key, minted once and reused across retries so a
  // retry racing its own in-flight 409 is server-deduped rather than double-sent.
  durableRunKey: string;
  // 409 retry count; bounded so a permanently-stuck run eventually drops+toasts.
  attempts: number;
};

/**
 * Should this send be parked rather than sent immediately? Yes whenever a run
 * is streaming on the thread — the user's own or another member's — since the
 * server only allows one at a time. `allowWhileStreaming` marks the internal
 * replay path (the auto-send itself), which must never re-queue and cause a loop.
 *
 * Note: background tool/artifact work and pending approvals are handled earlier
 * (they block composing outright), so this only reasons about run activity.
 */
export function shouldQueueSend(input: {
  chatExecutionState: ChatExecutionState;
  allowWhileStreaming?: boolean;
}): boolean {
  if (input.allowWhileStreaming) {
    return false;
  }
  return input.chatExecutionState !== "idle";
}

/**
 * Decide what to do with a queued send that hit the 409 backstop: re-queue it
 * (attempts bumped, same id/key so the server dedupes the retry) until the cap,
 * then drop it (the caller toasts). Pure so the retry/cap logic is unit-testable.
 */
export function planQueuedSendRetry(input: {
  queued: QueuedSend;
  maxAttempts: number;
}): { requeued: QueuedSend } | { dropped: true } {
  const attempts = input.queued.attempts + 1;
  if (attempts > input.maxAttempts) {
    return { dropped: true };
  }
  return { requeued: { ...input.queued, attempts } };
}

/** A short single-line preview of a queued message for the pending-queue UI. */
export function queuedSendPreview(input: ChatSendInput): string {
  const text = input.content.trim();
  if (text.length > 0) {
    return text;
  }
  const imageCount = input.images?.length ?? 0;
  if (imageCount > 0) {
    return imageCount === 1 ? "1 image" : `${imageCount} images`;
  }
  return "Queued message";
}
