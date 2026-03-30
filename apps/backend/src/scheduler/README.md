# scheduler

Purpose of this directory:

- Define periodic schedules.
- Enqueue jobs on each schedule tick.

The scheduler process should not execute heavy business tasks directly.

Current phase note:

- Placeholder queue jobs are optional via `BACKEND_SCHEDULER_EXAMPLE_JOB_ENABLED`.
- Scheduler also runs billing reconcile checks for team subscription plan consistency.
