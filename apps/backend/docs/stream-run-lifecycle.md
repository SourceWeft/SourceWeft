# Stream and run lifecycle

## Model streams

Every opened model iterator has one owner. Reads, cancellation and close run in
the same response-capture context. Early closure aborts pending SDK reads before
awaiting `return`, including LangChain's prefetch, and closes at most once.
An already-opened billed stream also closes when its consumer returns before the
first read. A lazy stream that never opened a resource does not start a model
request merely to close it.

Each model attempt emits one terminal observation. Errors and cancellation can
carry the usage and Provider identity received before termination, including
metadata arriving during close. The backend records these on an `error`
generation and settles the observed usage once after closing the iterator.
Unknown usage/cost stays unknown; explicit zero remains distinct. Existing
covered/billed policies and response-header/Provider-field redaction are retained.

Close errors do not prevent settlement attempts. When an upstream or consumer
error already exists, a later close/settlement error does not replace it. After
any content reaches the consumer, another Provider does not replay the response.

## Context compression

Window truncation keeps complete assistant tool calls with their matching
results, including multiple tools in one assistant message. Old orphaned,
duplicated or incomplete tool groups are removed together. The current user turn
and system messages are retained; invalid tool history in the current turn fails
explicitly rather than sending an invalid sequence to the model.

The existing Deep Agents summarizer is retained. Its public keep window is
expanded to protect the current turn/system content, and a second full-history
summary request after context overflow is refused with the original error.
If protected content alone is too large, it remains intact and the overflow is
reported. Checkpoint replay does not repeatedly summarize the prior summary.
The dependency can append a history offload before attempting its refused second
summary; no second model call or new summary checkpoint is produced by that path.

## Durable runs

Stale recovery rechecks status and heartbeat while holding the existing run row
lock. A new heartbeat or terminal winner prevents stale recovery from finishing
the run, sending terminal SSE, or releasing an active lease.

Failed, cancelled and completed outcomes are committed before terminal SSE is
sent. CAS losers use the persisted outcome instead of constructing a successful
terminal result. If Redis notification fails after commit, attach reconstructs
the terminal events from the database, including an explicit `CHAT_RUN_STALE`
error and finish for an expired worker.

Preparation can fail before any message is inserted. Terminal updates only bind
message IDs that already exist in the same thread and scope; a deterministic ID
is not evidence that its message was persisted. The processor boundary uses the
same commit-before-notification path and preserves the original business error
if terminal persistence or notification also fails.

The existing active-run endpoint includes a `latestFailure` summary when the
latest run failed without a persisted assistant message. It rechecks workspace
membership and thread visibility, sanitizes the message for clients, and never
loads the run's request or snapshot for this summary. A newer active or terminal
run suppresses an older failure. The chat page displays this summary after live
updates and reloads without manufacturing message records.

A worker stops when its run is failed, completed, cancelled or no longer owned.
Progress/heartbeat returning no row is not treated as permission to continue.
The original durable error is carried through the abort signal; genuine user
cancellation retains its existing 499 behavior. No new run-state table, schema
migration or state-machine framework was added.
