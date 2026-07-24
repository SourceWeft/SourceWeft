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
  | "run_status";

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
};

export type ThreadEventSubscriber = {
  id: string;
  onEvent: (payload: ThreadEventPayload) => void;
};
