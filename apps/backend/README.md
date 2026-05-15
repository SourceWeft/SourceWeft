# Backend

This directory contains the backend runtime for SourceWeft.

Queue backend: BullMQ + Redis (skeleton only, minimal implementation).

Billing MVP (`pages + credits`) is backed by PostgreSQL tables managed by Drizzle.
OSS defaults enforce the configured free quota while keeping payment checkout
disabled unless `SOURCEWEFT_SAAS_ENABLED=true` and a billing provider are set.

Team subscription notes (current phase):

- Creem-backed `team_standard` subscription flow with webhook sync.
- Webhook audit trail stored in `billing_webhook_events`.
- Reconcile task auto-realigns team plans from subscription state.
- Ops alerts stored in `ops_alerts` and optionally delivered by email.

- `src/api`: HTTP API process
- `src/worker`: async job consumer process
- `src/scheduler`: timed job dispatcher process
- `src/modules`: business modules
- `src/shared`: shared backend utilities

The backend is one codebase with three runtime entry points.

Use `pnpm run dev` in this directory to start all three processes.

Auth and workspace MVP notes:

- Better Auth is mounted at `/api/auth/*`.
- Workspace APIs are exposed at `/v1/teams/:teamId/workspaces` and `/v1/context/*`.
- Run `pnpm migrate` to apply Better Auth, Drizzle migrations, and billing backfill.
- Run `pnpm db:generate` after schema changes to generate new Drizzle migration files.
- Scheduler example queue jobs are disabled by default; set `BACKEND_SCHEDULER_EXAMPLE_JOB_ENABLED=true` to enable.

Environment template: `apps/backend/.env.example`.
