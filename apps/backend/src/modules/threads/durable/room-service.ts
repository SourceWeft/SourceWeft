import { randomUUID } from "node:crypto";
import { notifyHub } from "../../../shared/notify-hub";

/**
 * The live "room" for a thread: an SSE stream of ID-only wake-ups (run state
 * changed, a message was committed) that lets every viewer's client reconcile
 * over REST without polling. It never carries content or authorization — the
 * caller (`ContentThreadService.openThreadRoom`) authorizes with `canViewThread`
 * before this generator is ever started, and the client re-fetches through the
 * same gate.
 *
 * Frames are thin on purpose. On a `run` frame the client calls the existing
 * `getActiveThreadRun` (thread-scoped, visibility-checked) and reconciles; on a
 * `message` frame it refetches messages. Reusing those endpoints avoids
 * duplicating the run presenter here and re-applies authorization server-side.
 */
const HEARTBEAT_MS = 15_000;
// A slow consumer's backlog collapses to one resync rather than growing without
// bound — every frame is only a wake-up, so coalescing loses nothing.
const MAX_PENDING = 64;

type RoomFrame =
  | { type: "ready" }
  | { type: "resync" }
  | { type: "message"; messageId?: string; role?: string }
  | { type: "run"; kind: string; runId?: string; status?: string };

function toSseFrame(frame: RoomFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`;
}

export async function* streamThreadRoom(input: {
  threadId: string;
  signal?: AbortSignal;
}): AsyncGenerator<string> {
  const pending: RoomFrame[] = [];
  let wake: (() => void) | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

  const resumeWait = () => {
    const resume = wake;
    wake = null;
    resume?.();
  };

  const push = (frame: RoomFrame) => {
    if (pending.length >= MAX_PENDING) {
      pending.length = 0;
      pending.push({ type: "resync" });
    } else {
      pending.push(frame);
    }
    resumeWait();
  };

  // Registered once (not per iteration) so listeners never accumulate. On abort
  // (client disconnect, via createSseResponse's onCancel) it wakes the parked
  // await so the loop exits into `finally` immediately instead of lingering up
  // to a heartbeat interval.
  let aborted = input.signal?.aborted ?? false;
  const onAbort = () => {
    aborted = true;
    resumeWait();
  };
  if (input.signal && !aborted) {
    input.signal.addEventListener("abort", onAbort, { once: true });
  }

  const unsubscribe = notifyHub.subscribe(input.threadId, {
    id: randomUUID(),
    onEvent: (payload) => {
      if (payload.kind === "message_created") {
        push({
          type: "message",
          messageId: payload.messageId,
          role: payload.role,
        });
      } else {
        push({
          type: "run",
          kind: payload.kind,
          runId: payload.runId,
          status: payload.status,
        });
      }
    },
  });

  try {
    yield toSseFrame({ type: "ready" });
    while (!aborted) {
      let frame = pending.shift();
      while (frame) {
        yield toSseFrame(frame);
        frame = pending.shift();
      }
      if (aborted) {
        break;
      }

      const outcome = await new Promise<"event" | "beat">((resolve) => {
        wake = () => resolve("event");
        heartbeatTimer = setTimeout(() => resolve("beat"), HEARTBEAT_MS);
      });
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      wake = null;
      if (aborted) {
        break;
      }
      if (outcome === "beat") {
        yield ": heartbeat\n\n";
      }
    }
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
    }
    unsubscribe();
  }
}
