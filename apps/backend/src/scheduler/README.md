# scheduler

Purpose of this directory:

- Define periodic schedules.
- Enqueue jobs on each schedule tick.

The scheduler process should not execute heavy business tasks directly.

Current phase note:

- Scheduler also runs billing reconcile checks for team subscription plan consistency.
