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

## MCP README fetch

Every 10 minutes (`MCP_README_SCHEDULE_INTERVAL_MS`) the scheduler queues one
`mcp-readme-fetch` batch of up to 800 MCP server versions whose README is due:
the latest published version of each published, public server, installed
servers first, then web-executable ones, then the rest. It only queues. The
worker reads GitHub's README API, because `GITHUB_TOKEN` is given to the api
and worker services and not to the scheduler. While a batch is queued or
running, no second one is queued. A spent rate limit defers the rest of the
batch to GitHub's reset. Refresh intervals, backoff and the attempt cap are
constants in `modules/market/readme/readme-state.ts`; there is no env
variable.

## MCP AI overviews

Every 5 minutes (`MCP_OVERVIEW_SCHEDULE_INTERVAL_MS`), while the system model
is ready, the scheduler queues up to 20 `mcp-overview-generate` jobs
(`modules/market/overview/queue.ts`, through the catalog overview engine's
batch). A candidate is the latest published version of a published, public
server whose README is no longer `pending`: first those never analysed,
installed servers first, then web-executable ones, then the rest; then, from a
window of 500 analysed versions that moves through the catalog, those whose
published overview was written from another input fingerprint (README,
manifest, packages, description, prompt or taxonomy changed) and failures worth
another try. A failure that keeps failing is tried again only after the README
is read again. The README fetch settling a version is what makes it a
candidate; there is no other coupling. It only queues; the worker calls the
system model. There is no env variable.

Current phase note:

- Scheduler also runs billing reconcile checks for team subscription plan consistency.
