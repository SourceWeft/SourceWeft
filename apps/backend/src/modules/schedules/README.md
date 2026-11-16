# schedules

The generic schedule engine over `task_schedules` and `schedule_occurrences`.

- `repository.ts`: the lifecycle every kind shares, parameterized by `taskKind`:
  materialize the newest due slot, claim occurrences under a lease, mark queued
  or skipped, retry with backoff.
- `engine.ts`: `runScheduleTick(adapter)`, the tick shape: materialize,
  reconcile queued occurrences, recover stale ones, dispatch, then upkeep.
- `slots.ts` / `jitter.ts`: the fixed-interval slot policy and the stable
  per-target offset.

A kind plugs in through a `ScheduleAdapter`: its time policy (`computeSlot`),
its overlap rule (`isTargetBusy`), and what queueing, reconciling and recovering
mean for the run it creates. The connector sync is the first adapter
(`scheduler/schedules/connectors.ts`); the occurrence is the outbox, so replaying
a dispatch is always safe.
