/**
 * The fixed limits of scheduled tasks. Code constants on purpose: none of
 * them is an environment variable or a config flag. The number of active
 * tasks a person may have comes from their plan instead
 * (`BillingRuntime.getScheduledTaskLimits`).
 */

/** Occurrences materialized, reconciled and dispatched per scheduler tick. */
export const AGENT_TASK_TICK_LIMIT = 25;

/** Runs one person may start in any 24 hours, scheduled and manual together. */
export const AGENT_TASK_DAILY_RUN_CAP = 50;

/** Scheduled runs one person may have in flight at the same time. */
export const AGENT_TASK_USER_CONCURRENCY = 2;

/** Failed runs in a row after which a task pauses itself. */
export const AGENT_TASK_MAX_CONSECUTIVE_FAILURES = 3;

/** "Run now" requests per hour: for one task, and for one person. */
export const AGENT_TASK_RUN_NOW_PER_TASK_PER_HOUR = 6;
export const AGENT_TASK_RUN_NOW_PER_USER_PER_HOUR = 20;

/** Attempts to start a run before the slot fails. A started run never reruns. */
export const AGENT_TASK_START_ATTEMPTS = 3;

/** A run still going after this long is stopped and recorded as failed. */
export const AGENT_TASK_RUN_TIMEOUT_MS = 30 * 60_000;

/** How long a blocked task waits between checks of what blocks it. */
export const AGENT_TASK_BLOCKED_RECHECK_MS = 10 * 60_000;

/**
 * A task blocked on missing tools or sources resumes by itself if they come
 * back within this long; after that it pauses until its owner enables it.
 * A task blocked on credits has no such deadline.
 */
export const AGENT_TASK_UNAVAILABLE_GRACE_MS = 72 * 60 * 60_000;
