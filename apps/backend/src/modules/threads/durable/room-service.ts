import { randomUUID } from "node:crypto";
import {
  publishThreadEvent,
  type RoomReservation,
  type ThreadEventPayload,
} from "../../../shared/notify-hub";
import { metrics } from "../../../shared/metrics";
import { dropPresence, readPresence, touchPresence } from "./presence-store";

/**
 * The live "room" for a thread: an SSE stream of ID-only wake-ups (run state,
 * a committed message, presence roster changes, typing) that lets every viewer's
 * client reconcile over REST without polling. It never carries content — the
 * caller (`ContentThreadService.openThreadRoom`) authorizes with `canViewThread`
 * before this generator starts, AND the generator re-authorizes on every beat
 * (`checkAccess`) so a viewer whose access is revoked mid-stream is dropped
 * within one beat (closes the Phase 2 revoke-after-open gap).
 *
 * Presence is connection-tied and needs no client heartbeat: the generator marks
 * the viewer present on connect and on every beat (the 15s heartbeat doubles as
 * the presence TTL refresh), reads the roster from Redis inside this authorized
 * stream, and emits it in the `presence` frame (userIds only; the client
 * resolves names). It drops presence in `finally`. Typing is ephemeral: a
 * `typing` wake-up from another viewer becomes a `typing` frame (self filtered).
 */
const HEARTBEAT_MS = 15_000;
// A slow consumer's backlog collapses to one resync rather than growing without
// bound — every frame is only a wake-up, so coalescing loses nothing.
const MAX_PENDING = 64;

type RoomFrame =
  | { type: "ready" }
  | { type: "resync" }
  | { type: "message"; messageId?: string; role?: string }
  | {
      type: "run";
      kind: string;
      runId?: string;
      status?: string;
      assistantMessageId?: string;
    }
  | { type: "presence"; here: string[] }
  | { type: "typing"; userId?: string };

function toSseFrame(frame: RoomFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`;
}

export function toRunRoomFrame(
  payload: ThreadEventPayload,
): Extract<RoomFrame, { type: "run" }> {
  return {
    type: "run",
    kind: payload.kind,
    ...(payload.runId ? { runId: payload.runId } : {}),
    ...(payload.status ? { status: payload.status } : {}),
    ...(payload.assistantMessageId
      ? { assistantMessageId: payload.assistantMessageId }
      : {}),
  };
}

export async function* streamThreadRoom(input: {
  threadId: string;
  workspaceId: string;
  viewerUserId: string;
  reservation: RoomReservation;
  checkAccess: () => Promise<boolean>;
  signal?: AbortSignal;
}): AsyncGenerator<string> {
  const { threadId, workspaceId, viewerUserId, checkAccess } = input;
  const connId = randomUUID();
  const pending: RoomFrame[] = [];
  let wake: (() => void) | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  // Set when a presence_changed wake-up arrives; the loop (not the sync onEvent)
  // does the async Redis read, coalescing a burst into one roster snapshot.
  let presenceDirty = false;
  // Set on an access_changed wake-up; the loop re-runs checkAccess and evicts if
  // the viewer no longer qualifies (sub-second, vs. the per-beat backstop).
  let accessDirty = false;

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

  // Presence Redis ops are guarded so a transient blip skips one beat's presence
  // work instead of unwinding the generator and dropping every viewer's SSE.
  const emitPresenceFrame = async (): Promise<string | null> => {
    try {
      const here = await readPresence(threadId);
      metrics.observe("presence.roster.size", here.length);
      return toSseFrame({ type: "presence", here });
    } catch {
      return null;
    }
  };

  const refreshPresence = async (): Promise<void> => {
    try {
      await touchPresence(threadId, viewerUserId, connId);
    } catch {
      // The TTL and the next beat compensate for a missed refresh.
    }
  };

  const broadcastPresenceChanged = () => {
    void publishThreadEvent({
      threadId,
      workspaceId,
      kind: "presence_changed",
    }).catch(() => undefined);
  };

  // Registered once (not per iteration) so listeners never accumulate. On abort
  // (client disconnect, via createSseResponse's onCancel) it wakes the parked
  // await so the loop exits into `finally` immediately.
  let aborted = input.signal?.aborted ?? false;
  const onAbort = () => {
    aborted = true;
    resumeWait();
  };
  if (input.signal && !aborted) {
    input.signal.addEventListener("abort", onAbort, { once: true });
  }

  // Attach the real subscriber into the admission slot reserved by
  // openThreadRoom (the capped path). Released in `finally`.
  input.reservation.attach({
    id: connId,
    onEvent: (payload) => {
      if (payload.kind === "presence_changed") {
        presenceDirty = true;
        resumeWait();
        return;
      }
      if (payload.kind === "access_changed") {
        accessDirty = true;
        resumeWait();
        return;
      }
      if (payload.kind === "typing") {
        // Self-filter: the typist doesn't need their own indicator.
        if (payload.actorUserId && payload.actorUserId !== viewerUserId) {
          push({ type: "typing", userId: payload.actorUserId });
        }
        return;
      }
      if (payload.kind === "message_created") {
        push({
          type: "message",
          messageId: payload.messageId,
          role: payload.role,
        });
        return;
      }
      push(toRunRoomFrame(payload));
    },
  });

  try {
    metrics.inc("room.connects");
    yield toSseFrame({ type: "ready" });

    // Join, hand the client the current roster, and tell peers to refresh.
    await refreshPresence();
    const initial = await emitPresenceFrame();
    if (initial) {
      yield initial;
    }
    broadcastPresenceChanged();

    // The beat runs on a WALL-CLOCK deadline, not a per-iteration relative timer:
    // on a busy thread a steady event stream would otherwise keep resetting the
    // timer so the beat (re-auth + presence TTL refresh) would never fire.
    let nextBeatAt = Date.now() + HEARTBEAT_MS;

    while (!aborted) {
      let frame = pending.shift();
      while (frame) {
        yield toSseFrame(frame);
        frame = pending.shift();
      }
      if (aborted) {
        break;
      }

      if (accessDirty) {
        accessDirty = false;
        // A transient error is not a revocation — ride through and let the beat
        // re-check; a definitive false evicts now.
        const allowed = await checkAccess().catch(() => true);
        if (!allowed) {
          break;
        }
        if (aborted) {
          break;
        }
      }

      if (presenceDirty) {
        presenceDirty = false;
        const snapshot = await emitPresenceFrame();
        if (snapshot) {
          yield snapshot;
        }
        if (aborted) {
          break;
        }
      }

      if (Date.now() >= nextBeatAt) {
        // Re-authorize mid-stream (finding #8). A transient error is not a
        // revocation, so ride through it and re-check next beat rather than
        // evict a valid viewer; on a real revocation break so finally drops
        // presence + broadcasts + ends the SSE.
        const allowed = await checkAccess().catch(() => true);
        if (!allowed) {
          break;
        }
        await refreshPresence();
        yield ": heartbeat\n\n";
        // Fresh roster every beat means TTL-expired ghosts self-clear for
        // everyone within one beat, with no expiry-broadcast machinery.
        const beatSnapshot = await emitPresenceFrame();
        if (beatSnapshot) {
          yield beatSnapshot;
        }
        nextBeatAt = Date.now() + HEARTBEAT_MS;
        // Re-drain events that arrived during the beat's awaits before parking.
        continue;
      }

      await new Promise<void>((resolve) => {
        wake = () => resolve();
        // Observe a flag set during a prior await (when wake was null), so a
        // roster change OR a pending access revocation isn't deferred up to a
        // full heartbeat.
        if (aborted || accessDirty || presenceDirty || pending.length > 0) {
          resolve();
          return;
        }
        heartbeatTimer = setTimeout(
          resolve,
          Math.max(0, nextBeatAt - Date.now()),
        );
      });
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      wake = null;
    }
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
    }
    input.reservation.release();
    metrics.inc("room.disconnects");
    void dropPresence(threadId, viewerUserId, connId).catch(() => undefined);
    broadcastPresenceChanged();
  }
}
