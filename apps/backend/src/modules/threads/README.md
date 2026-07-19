# threads

Chat threads: persistence, turn orchestration, the agent runtime, and the two
ways a turn reaches the client.

~30k lines across five subdirectories. Read this before changing anything here —
the `durable` / `stream` split is the part that most often gets misread.

## Layout

| Directory | Responsibility | Entry point |
|---|---|---|
| `durable/` | Run lifecycle: BullMQ queueing, heartbeats, cancellation, approval pauses, stale detection, Redis event buffer | `service.ts` `DurableChatRunService`, `runner.ts` `processThreadChatRunJob` |
| `stream/` | Turns one turn into a stream of SSE events | `service.ts` `streamThreadEvents` |
| `turn/` | Prepares and finalizes a single turn (orchestration, not the agent itself) | `service.ts` `prepareThreadTurn` / `finalizeThreadTurn` |
| `agent/` | The deepagents runtime, tools, middleware, sandbox, filesystem backends | `index.ts` `createThreadAgent`, `turn/runner.ts` `invokeDeepAgentTurn` |
| `thread/` | The thread record itself: repository, title generation, model catalog | `repository.ts` |
| (root) | Thread CRUD, preferences, message repository | `service.ts` `contentThreadService` |

## durable vs stream

The single most important fact: **the dependency is one-way.** `stream/`,
`turn/`, and `agent/` contain no reference to `durable/`. Only `durable/`
imports `stream/`.

- **`stream/`** does not manage run lifecycle and knows nothing about durable
  runs. It is *not* stateless, though — it writes the user message
  (`turn/preparer.ts`) and the assistant message (`turn/finalizer.ts`) to the
  database. Describe it as "unaware of runs", not "stateless".
- **`durable/`** owns everything about a run: status transitions, the BullMQ
  job, the Redis event buffer, heartbeats, cancellation, approval pauses.

### How they connect

`durable/runner.ts` is the seam, in three steps:

1. `processThreadChatRunJob` (`runner.ts`) is the worker entry.
   `durableChatRunService.processRunJob` is only its first step — it performs
   status transitions and short-circuits; it does not hand off execution.
2. `createThreadRunStream` (`runner.ts`) dispatches on `request.mode` to
   `streamThreadEvents` / `refreshThreadEvents` / `editThreadEvents` /
   `resumeThreadEvents`, then constructs **a new** `ContentThreadStreamService`
   rather than reusing the exported singleton.
3. The runner consumes the generator and writes each event into Redis via
   `appendRunEvent` → `chatRunStreamManager.appendEvent` (a Redis LIST, 24h TTL).
   The stream service never writes to Redis itself.

Clients read back through `attachRunEvents`, which polls the Redis list every
100ms and emits an SSE heartbeat every 15s.

## Two request paths

`POST /threads/:id/stream` forks on the idempotency key. Only keys carrying
`SOURCEWEFT_WEB_RUN_IDEMPOTENCY_PREFIX` take the durable path.

**Durable path** — survives worker restarts, supports re-attach and cancel:

```
route → getOrCreateRun → enqueue BullMQ job → attachRunEvents (SSE starts now)
                                    ↓ (in parallel, in the worker)
   processThreadChatRunJob → createThreadRunStream → streamThreadEvents
        → prepareThreadTurn → invokeDeepAgentTurn → event-mapper
        → appendRunEvent → Redis LIST → picked up by attachRunEvents above
```

**Direct path** — route calls `streamThreadEvents` and pipes it straight to the
response. Simpler, but the stream dies with the process and cannot be
re-attached. Anything user-facing should use the durable path.

## Run state machine

States (`durable/types.ts`): `queued`, `running`, `cancel_requested`,
`waiting_for_approval`, `completed`, `failed`, `cancelled`.

`cancel_requested` and `waiting_for_approval` count as **active** — they block a
new run on the same thread.

```
        create ──▶ queued ──▶ running ──▶ completed | failed | cancelled
                                 │
                                 ├──▶ cancel_requested   (stopRun)
                                 └──▶ waiting_for_approval
                                          │
                                          ├──▶ completed  (all approvals answered)
                                          └──▶ cancelled  (stopRun, or TTL sweep)
```

### Approval pause

Triggered when a turn finishes with `finishReason === "tool_confirmation_requested"`.
`markWaitingForApproval` records `approvalRequestedAt`, `approvalExpiresAt`, and
`pendingConfirmationIds` in the snapshot.

**Answering an approval does not resume the run.** The run is closed as
`completed`, and the client must start a *new* run with `mode: "resume"` and a
`toolApprovalResume` payload. Expired approvals are swept by the scheduler.

## Traps

1. **Stale detection has two thresholds.** A `queued` run with no `jobId` is
   stale after 10s; everything else after 10min without a heartbeat.
   `waiting_for_approval` is explicitly excluded and is *never* considered
   stale — only the TTL sweep can clear it.

2. **One active run per thread, enforced three times.** `getOrCreateRun` checks
   for an active run, re-checks, and finally catches a unique-constraint
   violation — all raising 409 `CHAT_RUN_ALREADY_ACTIVE`. That depth of defence
   exists because the race is real.

3. **Idempotency keys have two forms.** A key ending in
   `SOURCEWEFT_WEB_RUN_STOP_SUFFIX` means *stop this run*, not *run this*.
   Re-sending the same run key re-attaches to the existing stream instead of
   creating a second run.

4. **Cancellation is polled, not signalled.** `shouldCancel` hits the database,
   and the stream service only checks it between agent events. A long-running
   tool call will not be interrupted promptly.

5. **Text deltas are coalesced** before being appended to Redis. Do not rely on
   individual delta boundaries downstream.

6. **The Redis event list is read with `LRANGE offset -1`**, and `hasStop`
   rescans from offset 0 — O(n) on long runs.

7. **The worker builds its own `ContentThreadStreamService`** instead of using
   the exported singleton, with several `undefined` constructor placeholders.
   Changing that constructor means changing both call sites.

8. **The job name lives in `modules/content/queue.ts`.** `durable/constants.ts`
   used to carry an unused duplicate; keep it defined in one place.
