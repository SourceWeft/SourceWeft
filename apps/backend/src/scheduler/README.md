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

Every 5 minutes (`MCP_README_SCHEDULE_INTERVAL_MS`) the scheduler queues one
`mcp-readme-fetch` batch of up to 5,000 MCP server versions whose README is
due: the latest published version of each published, public server, installed
servers first, then versions never read, then the newest versions. It only
queues. The worker reads GitHub's GraphQL API, 20 directories per query and
three queries at a time, because `GITHUB_TOKEN` is given to the api and worker
services and not to the scheduler. GraphQL has no anonymous access: without
`GITHUB_TOKEN` the batch reads nothing and says so in the admin status. While a
batch is queued or running, no second one is queued. A spent rate limit defers
the rest of the batch to GitHub's reset. A new version of a server starts with
the previous version's README and is read again at once. Refresh intervals,
backoff and the attempt cap are constants in
`modules/market/readme/readme-state.ts`; there is no env variable.

## MCP stdio package validation

Every 15 minutes (`MCP_STDIO_SCHEDULE_INTERVAL_MS`), while the deployment has
a sandbox runtime (`SOURCEWEFT_SANDBOX_ENABLED=true`), the scheduler queues one
`mcp-stdio-validate` batch of up to 6 MCP server versions whose registry entry
lists `packages[]`: the latest published version of each published, public
server, never-tried ones first, then the newest. It only queues. The worker
(`worker/processors/mcp-stdio-validate.ts`) starts each package once in a
fresh provider sandbox — no credentials, the registry's required inputs filled
with placeholders, two at a time — performs the MCP handshake over stdio and
stores the server's self-description and tools on the version, or why it could
not be validated (`install`, `start`, `protocol`, `timeout`,
`unsupported-package`). The sandbox is deleted afterwards; each sandbox is
also recorded in a Redis ledger until deleted, and every batch first deletes
the sandboxes a dead worker left there. While a batch is queued or running,
no second one is queued. A version is due again 30 days after its last
outcome; a claimed version is held for 30 minutes so a worker that died
mid-batch only delays it. A sandbox that could not be used at all is tried
three times, then stored as a failure. Batch size, concurrency, timeouts and the
refresh interval are constants in `modules/market/validation/`; there is no env
variable. Six per batch, two at a time, paces the first pass over the
catalog's ~1,500 packages across about three days on purpose: each one is
third-party code in a paid sandbox.

## MCP AI overviews

Every `MCP_OVERVIEW_INTERVAL_MS` (5 minutes by default), while the system
model is ready, the scheduler queues up to `MCP_OVERVIEW_BATCH_SIZE` (20 by
default) `mcp-overview-generate` jobs (`modules/market/overview/queue.ts`,
through the catalog overview engine's batch). A candidate is the latest published version of a published, public
server whose README is no longer `pending`: first those never analysed,
installed servers first, then web-executable ones, then the rest; then, from a
window of 500 analysed versions that moves through the catalog, those whose
published overview was written from another input fingerprint (README,
manifest, packages, description, prompt or taxonomy changed) and failures worth
another try. A failure that keeps failing is tried again only after the README
is read again. The README fetch settling a version is what makes it a
candidate; there is no other coupling. It only queues; the worker calls the
system model.

The pace is the two variables above, read by the scheduler (`config.market`):
the batch is 1 to 1000 versions and the interval 10 seconds to 24 hours, and a
value outside that or not an integer fails startup. The defaults work a large
catalog through at about 260 overviews an hour; raise them for a while to get
through a backlog, then put them back. Overview jobs carry a low queue
priority (`OVERVIEW_JOB_PRIORITY` in `modules/catalog-overview/jobs.ts`), so
the worker takes jobs with no priority — chat turns, titles, syncs, parses —
first however large the batch.

Current phase note:

- Scheduler also runs billing reconcile checks for team subscription plan consistency.
