# scheduler

Purpose of this directory:

- Define periodic schedules.
- Enqueue jobs on each schedule tick.

The scheduler process should not execute heavy business tasks directly.

## Connector indexing

Connector schedules are stored in `task_schedules`; only the
`connector_sync` task kind is dispatched today. A scheduler tick atomically
materializes the newest due interval into `schedule_occurrences`, then claims
pending occurrences and enqueues deterministic BullMQ jobs. Missed intervals
coalesce into one run, and the scheduled path holds at most one active sync
plus one pending occurrence. An occurrence left during an enqueue failure is retried
from the database rather than lost with the scheduler process.
All connector sync trigger types use a connector-scoped PostgreSQL advisory
lock while applying provider changes, so manual and webhook runs cannot apply
concurrently with a scheduled run.

Connector schedules default to manual. Pausing a schedule stops future starts
without canceling an already running sync. A manual sync does not reset the
recurring interval. The connector adapter owns provider progress;
`connector_sync_state` stores its committed checkpoint and in-flight page
continuation separately from schedule timing. Adapter pages advance only after
all page items apply successfully.

The scheduler polls every `SCHEDULER_INTERVAL_MS` (60 seconds by default), so
the configured interval is a best-effort cadence rather than an exact start
time. Queue and provider failures are recorded on the occurrence and connector
schedule; authentication failures disable future automatic attempts until a
user reconnects and reenables periodic indexing.

The schedule schema reserves an `agent_task` kind and user ownership for future
user-created tasks. The dispatcher currently filters to `connector_sync`, and
there is no user-task creation API or worker handler.

Current phase note:

- Scheduler also runs billing reconcile checks for team subscription plan consistency.
