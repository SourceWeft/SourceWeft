# agent-tasks

Scheduled tasks: a saved prompt that runs as its owner, on a time rule or on
demand. A task is one `agent_tasks` row, one `task_schedules` row
(`task_kind = 'agent_task'`) holding the rule, and one `schedule_occurrences`
row per run. A run is an ordinary durable chat run in a new conversation
(`threads.origin = 'scheduled'`) of the owner; nothing here executes a model.

## Files

- `schedule.ts`: what is specific to a task's schedule. The one-hour minimum
  between fire times, the fixed per-task offset, the preview a form shows, the
  time columns of the schedule row for a saved rule, and the plan for a due one.
  The time math itself is generic and lives in `modules/schedules`.
- `service.ts`: what a person does to their own tasks: create, read, list,
  edit, delete, pause, resume, activate, run now, read the run history. Every
  lookup includes the owner and the workspace, so somebody else's task is a 404. The team is always the stored row's.
- `runs.ts`: what the scheduler does (`scheduler/schedules/agent-tasks.ts` is
  the adapter for the shared engine): materialize due slots, claim, dispatch,
  bring a run's outcome back, and look at blocked tasks again.
- `repository.ts`: the SQL. `ports.ts`: everything owned by another module
  (workspace access, billing, the chat run, notifications, audit, the rate
  limiter), behind one interface that tests replace.
- `limits.ts`: the fixed limits. Code constants; none is an env variable.

## What happens to a slot

A due schedule gets one occurrence for its newest elapsed slot. A slot that is
more than 15 minutes late is a catch-up run (`is_catch_up`, the owner is told
in the app); one older than a period (at most a day) and every slot before the
newest are recorded as `skipped / missed_platform_down` and never run. Pausing
or blocking a task disables its schedule and enabling it again starts from the
next fire time, so a slot is only ever late because the platform was.

Dispatch then decides, in this order, and records the reason on the occurrence
whenever the slot does not run:

| Check                                                      | Occurrence                                        | Task                             |
| ---------------------------------------------------------- | ------------------------------------------------- | -------------------------------- |
| task not active (or, by hand, not draft / active / paused) | `cancelled`                                       | unchanged                        |
| owner can no longer work in the workspace                  | `blocked / owner_left`                            | `paused / owner_left`            |
| every source gone, or an MCP install gone                  | `blocked / tools_unavailable`                     | `blocked / tools_unavailable`    |
| the task's previous run still going                        | `skipped / previous_run_active`                   | unchanged                        |
| owner already has 2 scheduled runs going                   | `skipped / user_concurrency_limit`                | unchanged                        |
| owner started 50 runs in the last 24 hours                 | `skipped / user_daily_cap`                        | unchanged                        |
| billing enforced and no credits (not for BYOK)             | `blocked / insufficient_credits`                  | `blocked / insufficient_credits` |
| otherwise                                                  | `queued`, linked to the chat run and conversation | unchanged                        |

Only starting a run is retried (three attempts, with backoff). A run that has
started is never run again. The conversation id and the run's idempotency key
are derived from the task and the occurrence, so a dispatch replayed after a
crash finds what it already made.

When the chat run ends the occurrence becomes `succeeded`, `failed` or
`cancelled` (stopped by its owner). Three failed scheduled runs in a row pause
the task (`repeated_failure`); a success resets the count. A run still going
after 30 minutes is stopped and recorded as failed. A one-time task is
`completed` after its run.

A blocked task is looked at again every ten minutes. Blocked on credits, it
resumes when there are credits, however long that takes. Blocked on tools, it
resumes if they return within 72 hours and pauses after that. Neither makes up
for slots that passed in between. An owner who left is never replaced: the
task pauses and stays theirs.

## Run now

`run-now` creates a `manual` occurrence, leased to the request, and dispatches
it through the same function the scheduler uses: same checks, same tool
policy, same billing, counted toward the daily cap. It does not move the
schedule. The occurrence id is derived from the caller's idempotency key, so a
repeated click is the same run. Six an hour per task and twenty per person;
past that the answer is 429 and nothing is queued. If the request dies before
dispatching, the scheduler picks the slot up when its lease ends.

## Nobody is present

The chat run is marked `unattended` and the turn pipeline applies
`modules/threads/agent/unattended-policy.ts`: read-class tools only, no
sandbox, no `askUser`, nothing that asks for approval, and a `<scheduled_run>`
block in the prompt. This module does not decide which tools those are.

## Notifications and audit

`notify()` from `modules/notifications`, always about the task
(`ref = agent_task:<id>`), with the task's name and at most a conversation id
in the payload: never the prompt or the result. `notifyOnSuccess` turns the
success notice off; `notifyEmail` turns all mail off. Every change of a task
by its owner, and every block, pause and resume by the platform (actor null),
is written to the team audit log as `agent_task.*`.
