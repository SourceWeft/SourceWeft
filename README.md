# SourceWeft Monorepo

This repository contains the SourceWeft skeleton architecture.

Current platform scope:

- `apps/web`: Next.js web app
- `apps/extension`: browser extension (WXT, Chrome/Edge MV3)
- `apps/desktop`: desktop app (Tauri)
- `apps/backend`: backend runtime (`api`, `worker`, `scheduler`)

Shared packages:

- `packages/contracts`: shared API/job contracts
- `packages/credits-core`: pure billing and metering primitives
- `packages/sdk`: shared frontend API client
- `packages/domain`: shared business rules
- `packages/ui` (package name: `@sourceweft/ui-web`): shared web UI components

Queue/runtime skeleton:

- BullMQ + Redis
- No in-memory queue
- Cancel/events are placeholder behavior in this phase

Billing MVP skeleton:

- Team-scoped billing API shape (`/v1/teams/:teamId/billing/*`)
- Individual-first `pages + credits` metering backed by PostgreSQL
- Team subscription flow with Creem (`team_standard`) and webhook-driven plan sync
- Webhook audit + alerts (`billing_webhook_events`, `ops_alerts`) and scheduler reconcile
- Config-driven billing modes: `disabled | shadow | enforced`

Auth + workspace MVP:

- Better Auth mounted in backend at `/api/auth/*`
- Web supports Google One Tap, Email OTP, GitHub OAuth, Passkey, Password, and Magic Link
- Organization plugin used for team-level identity boundary
- Workspace operations exposed via `/v1/teams/:teamId/workspaces` and shell-based switching UI
- Team management UI at `/app/team` (members + invitations)
- Extension uses OAuth2 PKCE (`launchWebAuthFlow`) with bearer token requests

## Environment Variables

- Each app has its own `.env.example`.
- Root does not store concrete env values.
- See `docs/env.md` for env policy and setup.

## Quick Start

Install dependencies:

```bash
pnpm install
```

Run all dev tasks via turbo:

```bash
pnpm dev
```

Run backend only:

```bash
pnpm --filter @sourceweft/backend dev
```

Type check everything:

```bash
pnpm check-types
```

## Architecture Reference

- Main architecture doc: `docs/architecture.md`
- AI runtime integration guide: `docs/ai-runtime-integration-guide.md`
- Env management doc: `docs/env.md`
- Team billing ops runbook: `docs/team-billing-ops-runbook.md`
