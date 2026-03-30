# api

Purpose of this directory:

- Host HTTP routes for synchronous backend operations.
- Validate input and enqueue long-running jobs.
- Return job status and events for frontend polling.

The API process should not execute heavy jobs directly.

Current phase note:

- This is a skeleton implementation wired to BullMQ.
- Billing MVP endpoints are available under `/v1/teams/:teamId/billing/*`.
- Better Auth is mounted at `/api/auth/*`.
- Workspace APIs are available under `/v1/teams/:teamId/workspaces` and `/v1/context/*`.
- Content APIs are available under `/v1/workspaces/:workspaceId/sources*` and `/v1/workspaces/:workspaceId/threads*`.
- Errors are returned in a unified shape: `{ code, message, details? }`.
- Business-specific job logic is intentionally not implemented yet.
- Job cancellation endpoint is a placeholder and returns `{ implemented: false }`.
- Job events endpoint currently returns an empty list placeholder.
