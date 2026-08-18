/**
 * Postgres LISTEN/NOTIFY transport for live thread collaboration.
 *
 * A single static channel carries every thread event; the hub routes to
 * subscribers by `threadId` in the payload (Postgres has no wildcard LISTEN, so
 * per-thread channels would mean constant LISTEN/UNLISTEN churn).
 *
 * The payload is an ID-only, non-authoritative wake-up. It never carries message
 * content and never carries authorization — clients reconcile the actual data
 * over REST, gated by `canViewThread`. Keeping it to IDs also keeps it far under
 * the 8000-byte NOTIFY limit.
 */
export const THREAD_EVENTS_CHANNEL = "thread_events";

export type ThreadEventKind =
  | "message_created"
  | "run_created"
  | "run_started"
  | "run_waiting_approval"
  | "run_cancel_requested"
  | "run_finished"
  | "run_status"
  | "artifact_output"
  // Presence: an ID-only wake-up that the viewer roster changed (join/leave).
  // Carries NO roster — the room generator reads it from Redis inside the
  // authorized stream and emits it in the SSE frame.
  | "presence_changed"
  // Typing: ephemeral; `actorUserId` is (or stopped) typing. Never any content.
  | "typing"
  // A thread's access changed (e.g. flipped to private). Room subscribers
  // re-check `canViewThread` and end their stream if they no longer qualify —
  // sub-second eviction on top of the per-beat backstop.
  | "access_changed";

export type ThreadEventPayload = {
  threadId: string;
  workspaceId: string;
  kind: ThreadEventKind;
  actorUserId?: string;
  messageId?: string;
  role?: "user" | "assistant";
  runId?: string;
  status?: string;
  assistantMessageId?: string;
  userMessageId?: string;
  // Only on kind:"typing" — whether the actor started (true) or stopped typing.
  typing?: boolean;
};

export type ThreadEventSubscriber = {
  id: string;
  onEvent: (payload: ThreadEventPayload) => void;
};
