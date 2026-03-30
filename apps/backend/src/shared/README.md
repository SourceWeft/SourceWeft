# shared

Purpose of this directory:

- Store shared backend utilities and primitives.
- Keep cross-process helpers in one place.

Examples in this skeleton:

- `config.ts`: runtime configuration
- `logger.ts`: logging helper
- `redis-connection.ts`: shared Redis connection options for BullMQ
- `queue.ts`: BullMQ + Redis queue wiring
- `job-status.ts`: queue-state to API-status mapping
