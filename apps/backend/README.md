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
- Google sign-in mirrors GitHub's Better Auth callback pattern. Configure
  `AUTH_GOOGLE_SIGNIN_WEB_CLIENT_ID` and
  `AUTH_GOOGLE_SIGNIN_WEB_CLIENT_SECRET`; the Google Cloud OAuth client must
  allow `<NEXT_PUBLIC_API_BASE_URL>/api/auth/callback/google`.
- Google One Tap and native mobile sign-in use ID tokens. Configure
  `AUTH_GOOGLE_ONE_TAP_CLIENT_ID` and `AUTH_GOOGLE_MOBILE_CLIENT_ID` for those
  audiences; they do not choose the browser OAuth redirect client.
- Future Google Workspace connectors should use
  `GOOGLE_CONNECTORS_OAUTH_CLIENT_ID` / `GOOGLE_CONNECTORS_OAUTH_CLIENT_SECRET`
  plus connector-specific redirect URI envs instead of implicitly reusing
  sign-in credentials.
- Workspace APIs are exposed at `/v1/teams/:teamId/workspaces` and `/v1/context/*`.
- Run `pnpm migrate` to apply Better Auth migrations followed by Drizzle business migrations.
- Run `pnpm db:generate` after schema changes to generate new Drizzle migration files.
- Scheduler example queue jobs are disabled by default; set `BACKEND_SCHEDULER_EXAMPLE_JOB_ENABLED=true` to enable.

Environment template: `apps/backend/.env.example`.

Sandbox developer notes live in
`src/modules/content/agent/sandbox/README.md`. They describe the provider-neutral
runtime model, Daytona adapter boundary, backend-provided `execute`, prepare and
collect bridge semantics, audit states, and current idempotency limitations.

Model gateway catalog sync:

- Global provider keys remain optional environment variables.
- Dynamic provider model discovery is configured per gateway in
  `apps/backend/config/model-gateway.global.json` with
  `modelCatalog.enabled`; the removed `MODEL_GATEWAY_SYNC_OPENROUTER_CATALOG`
  environment variable is no longer used.
- If `modelCatalog.kinds` is omitted, the scheduler imports every model kind
  that the catalog adapter can classify and the gateway transport supports.
- Hand-written profiles in the JSON remain available when catalog sync is
  disabled. Global dynamic catalog import skips models that cannot be matched
  to LiteLLM pricing/capabilities; BYOK still allows manual unknown models.
