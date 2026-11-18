# schedules

The generic schedule engine over `task_schedules` and `schedule_occurrences`.

- `repository.ts`: the lifecycle every kind shares, parameterized by `taskKind`:
  materialize the newest due slot, claim occurrences under a lease, mark queued
  or skipped, retry with backoff.
- `engine.ts`: `runScheduleTick(adapter)`, the tick shape: materialize,
  reconcile queued occurrences, recover stale ones, dispatch, then upkeep.
- `slots.ts` / `jitter.ts`: the fixed-interval slot policy and the stable
  per-target offset.
- `rules.ts` / `wall-time.ts`: calendar time rules (`manual`, `daily`,
  `weekly`, `weekdays`, `cron`, `once`) in an IANA time zone. Pure functions:
  the next fire times of a rule, the check a rule must pass before it is saved
  (parseable, never more often than the caller's minimum interval), and
  `planDueSlot`, which decides what an overdue schedule does: run the newest
  elapsed slot if it is younger than one period (at most a day), report older
  ones as missed. Daylight saving is decided here, not by the cron library: a
  repeated wall time fires once, a skipped one fires at the jump.

A slot's `scheduled_for` is its nominal time. A schedule's `next_due_at` is
that time plus the target's fixed offset, so the slot key stays stable and
readable while the work is spread out.

A kind plugs in through a `ScheduleAdapter`: its time policy (`computeSlot`),
its overlap rule (`isTargetBusy`), and what queueing, reconciling and recovering
mean for the run it creates. The connector sync is the first adapter
(`scheduler/schedules/connectors.ts`); the occurrence is the outbox, so replaying
a dispatch is always safe.
