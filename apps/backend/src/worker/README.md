# worker

Purpose of this directory:

- Consume queued jobs.
- Execute async or heavy tasks outside API request lifecycle.
- Update job status and events.

`main.ts` is the worker entry point.

Current phase note:

- Worker processors are skeleton placeholders only.
- Domain-specific job execution will be added incrementally.
