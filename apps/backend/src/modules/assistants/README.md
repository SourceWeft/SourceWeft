# assistants

The workspace assistant (#692): a standing, per-workspace router that turns
member messages and worker reports into tickets, each worked by its own
worker thread. `assistants` is one row per workspace holding the Router
thread and its status; `assistant_tickets` is one piece of work each;
`assistant_feed_items` is the shared timeline a member reads to follow the
assistant and its tickets; `assistant_triggers` is the Router's inbox of
events still to be judged.

This task (5) is the service layer only: enable, steward, the feed, member
messages, and ticket close/retry. Tasks 6-7 add this module's Router/worker
and the dispatch logic that actually turns a trigger into a decision; Task 8
adds the HTTP routes that call this service.

## Files

- `service.ts`: what a person does — enable the assistant, read it, pause,
  resume or hand it to a new steward, post a message, read the feed and the
  ticket list, close or retry a ticket. Every lookup is scoped to the
  caller's own workspace, so somebody else's workspace is a 404 (consistent
  with `modules/agent-tasks`).
- `repository.ts`: the SQL. `ports.ts`: everything owned by another module
  (workspace access, credits, the host-started turn, stopping a run,
  notifications, audit), behind one interface tests replace.
- `limits.ts`: `ASSISTANT_LIMITS`, re-exported from contracts. Code
  constants; none is an environment variable.
- `errors.ts`: `AssistantError` / `isAssistantError`.

## Enabling

Only a container admin (an organization owner/admin, or whoever the
container-admin plane says may administer the workspace) may enable the
assistant. `enable` pre-creates the Router conversation with a deterministic
id (`deterministicId("assistant-router", workspaceId)`, the same tool
`agent-tasks/runs.ts` uses — there is exactly one id-derivation function in
this codebase, not a second one here) before writing the `assistants` row, so
the row never points at a Router thread that was never created. The Router
thread carries no foreign key (see `packages/db/src/schema/assistants.ts`)
and its creation is idempotent (same id, `on conflict do nothing`), so this
ordering is safe even if the transaction that writes the `assistants` row
then fails (a concurrent `enable`, surfaced as `ASSISTANT_ALREADY_ENABLED`):
at worst it leaves behind an unreferenced thread row. The Router conversation
is visible to the whole workspace (`visibility: "workspace"`) when the
workspace's organization is a team organization or cannot be classified at
all, and left at the default (`private`) for a personal organization — the
same personal/team line `modules/workspace/service.ts`'s
`ensureMembershipWorkspace` draws from the organization's metadata. The
enabling admin becomes the initial steward. All later Router runs
(Task 6-7) start with `existingThread: true` against this same thread.

## Member messages

`postMessage` derives one id
(`deterministicId("assistant-msg", assistantId, userId, idempotencyKey)`)
used as both the feed item's id and its trigger's (the trigger's primary key
and its `dedupe_key`). A double-click or a network retry therefore produces
exactly one feed item and one trigger: the replay is detected before any
write and handed back with `created: false`, never a 409. `kickAssistant`
(injected into `AssistantService`; the production singleton passes
`dispatch.ts#kickAssistant`, which never throws) is called once, only for a
genuinely new message, after the write commits.

## Tickets

Task 5 only acts on tickets the Router already created (Task 6-7 owns
creation and the decision that produces one): `closeTicket` ends it
(idempotent — already-`ended` is a no-op) and stops its worker run if one is
going; `retryTicket` inserts one more trigger already `decided` and routed
straight to the ticket (skipping evaluation) and clears its consecutive
failure count. The retry's own trigger id is derived from the ticket and the
caller's idempotency key, so a repeated click adds no second event.

## Worker and dispatch

- `worker/tools.ts`: `report`, the Worker's one tool. One transaction moves
  the ticket (`ready`/`dropped` → `idle`, `waiting`/`blocked`/`failed` →
  `waiting_person`, `outcome` = the status), stores the summary, adds a
  `worker_report` event (`status: summary`) for the Router and a
  `ticket_update` feed item; a `question` then notifies the payer
  (`assistant_question`). Refusals and failures come back as tool results,
  never thrown.
- `worker/prompt.ts`, `worker/render.ts`: the Worker's fixed instructions
  (the system started the turn, no person is there) and the message each
  worker run starts with, framed as data like the Router's batch.
- `register-turn-providers.ts`: the `assistant_router` and
  `assistant_ticket` origin turn providers, registered when the worker
  process starts. Each reads only its own `hostContext` keys and fails the
  turn when they do not resolve.
- `dispatch.ts`: `runAssistantTick` (the scheduler, every tick) and
  `kickAssistant` (right after a member's message). Per active assistant,
  under a per-assistant advisory lock: steward check (a steward who lost
  access pauses it, `steward_left`, without stopping running work), settle
  the Router's ended run, settle each ticket's ended worker run (no report,
  credit cap, credits, repeated failure, time limit), start worker runs
  within the slots (one reserved for a member's input; a payer without
  credits is blocked without taking a slot), then start the Router on its
  next batch (a payer without credits is passed over; a 409 gives the batch
  back with no attempt counted).
