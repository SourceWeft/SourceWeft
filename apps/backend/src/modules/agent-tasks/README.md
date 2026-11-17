# agent-tasks

Scheduled tasks: a saved prompt that runs as its owner, on a time rule or on
demand. A task is one `agent_tasks` row, one `task_schedules` row
(`task_kind = 'agent_task'`) holding the rule, and one `schedule_occurrences`
row per run.

So far this module holds only what is specific to a task's schedule
(`schedule.ts`):

- the limits a task's rule must respect (one hour between fire times) and the
  fixed per-task offset that spreads tasks away from the top of the hour;
- the preview a form shows (next five fire times);
- the time columns of the schedule row for a saved rule, and the plan for a
  due one (which slot runs, which older slots were missed).

The time math itself is generic and lives in `modules/schedules` (`rules.ts`,
`wall-time.ts`). Nothing here starts a run yet: there is no route, no
dispatcher and no adapter registered with the scheduler.
