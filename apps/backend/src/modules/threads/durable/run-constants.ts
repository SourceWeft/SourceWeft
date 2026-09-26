export const ATTACH_POLL_MS = 100;
export const ATTACH_HEARTBEAT_MS = 15_000;
export const RESULT_POLL_MS = 200;
export const STOP_RESULT_WAIT_TIMEOUT_MS = 10_000;
export const COMPLETE_RESULT_WAIT_TIMEOUT_MS = 120_000;
export const ORPHANED_QUEUED_RUN_GRACE_MS = 10_000;
export const STALE_ACTIVE_RUN_TIMEOUT_MS = 10 * 60_000;
/**
 * How long a run's worker must have been silent before its snapshot alone may
 * finish the run. The worker writes the final assistant message into the
 * snapshot moments before it commits, so a fresher heartbeat means it is still
 * finishing the run itself.
 */
export const SNAPSHOT_TERMINAL_RECOVERY_GRACE_MS = 30_000;
export const CLIENT_CANCELLED_CODE = "CLIENT_CANCELLED";
export const CLIENT_CANCELLED_MESSAGE = "Chat run was cancelled";
export const STALE_CHAT_RUN_CODE = "CHAT_RUN_STALE";
export const WORKER_SHUTDOWN_CODE = "CHAT_RUN_WORKER_SHUTDOWN";
export const WORKER_SHUTDOWN_MESSAGE =
  "The server restarted while this reply was running. Send the message again to continue.";
export const TOOL_APPROVAL_EXPIRED_CODE = "TOOL_APPROVAL_EXPIRED";
export const TOOL_APPROVAL_EXPIRED_MESSAGE = "Tool approval request expired";
export const ACTIVE_RUN_CONSTRAINT = "chat_thread_runs_thread_active_uq";
export const EXPIRED_APPROVAL_SWEEP_LIMIT = 100;
export const STALE_ACTIVE_RUN_SWEEP_LIMIT = 100;
