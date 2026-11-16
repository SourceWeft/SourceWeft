/** Same event for the same subject within this window folds into one row. */
export const NOTIFICATION_MERGE_WINDOW_MS = 24 * 60 * 60_000;

/** Everything a list row may carry: flat, small, never prompts or results. */
export type NotificationPayload = Record<
  string,
  string | number | boolean | null
>;
export const NOTIFICATION_PAYLOAD_MAX_BYTES = 2048;

type PathInput = { refId: string | null; payload: NotificationPayload };

export interface NotificationKindDefinition {
  /** Email unless the caller overrides (a per-task toggle, say). */
  defaultEmail: boolean;
  /** Mail template id; a kind without one is in-app only. */
  template: string | null;
  /** Where the notification leads, relative to the web base URL. */
  path(input: PathInput): string;
}

function taskPath({ refId }: PathInput) {
  return refId
    ? `/dashboard/scheduled/${encodeURIComponent(refId)}`
    : "/dashboard/scheduled";
}

/** A finished run leads to its conversation when it has one. */
function runPath(input: PathInput) {
  const threadId = input.payload.threadId;
  return typeof threadId === "string" && threadId
    ? `/dashboard/chat/${encodeURIComponent(threadId)}`
    : taskPath(input);
}

/**
 * The notification kinds. Adding a kind is one entry here (plus a template
 * when it can be emailed); the table and the service stay unchanged.
 */
export const NOTIFICATION_KINDS = {
  task_run_succeeded: {
    defaultEmail: false,
    template: "notification.task-run-succeeded",
    path: runPath,
  },
  task_run_failed: {
    defaultEmail: true,
    template: "notification.task-run-failed",
    path: runPath,
  },
  task_run_catch_up: {
    defaultEmail: false,
    template: null,
    path: runPath,
  },
  task_blocked_quota: {
    defaultEmail: true,
    template: "notification.task-blocked-quota",
    path: taskPath,
  },
  task_needs_approval: {
    defaultEmail: true,
    template: "notification.task-needs-approval",
    path: runPath,
  },
  task_paused_owner_left: {
    defaultEmail: true,
    template: "notification.task-paused-owner-left",
    path: taskPath,
  },
  task_paused_repeated_failure: {
    defaultEmail: true,
    template: "notification.task-paused-repeated-failure",
    path: taskPath,
  },
} as const satisfies Record<string, NotificationKindDefinition>;

export type NotificationKind = keyof typeof NOTIFICATION_KINDS;

export function notificationKindDefinition(
  kind: string,
): NotificationKindDefinition {
  const definition = (
    NOTIFICATION_KINDS as Record<string, NotificationKindDefinition>
  )[kind];
  if (!definition) throw new Error(`Unknown notification kind: ${kind}`);
  return definition;
}
