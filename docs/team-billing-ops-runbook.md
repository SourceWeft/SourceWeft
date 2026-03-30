# Team Billing Ops Runbook

This runbook covers operational handling for Team V1 billing (`team_standard`).

## Scope

- Creem subscription webhooks
- team plan sync (`subscriptions` -> `billing_accounts`)
- webhook audit trail and ops alerts
- scheduler reconcile behavior

## Data Tables

- `subscriptions`: current team subscription projection
- `billing_accounts`: current team metering and plan state
- `billing_webhook_events`: webhook processing audit trail
- `ops_alerts`: deduplicated operational alerts

## Required Environment Variables

Backend env keys (see `apps/backend/.env.example`):

- `BACKEND_BILLING_PROVIDER=creem`
- `BACKEND_TEAM_BILLING_ENABLED=true`
- `BACKEND_BILLING_RECONCILE_ENABLED=true`
- `CREEM_API_KEY`
- `CREEM_WEBHOOK_SECRET`
- `CREEM_TEAM_STANDARD_PRODUCT_ID`
- `BACKEND_ALERTS_ENABLED=true`
- `OPS_ALERT_EMAILS` (comma-separated)

## Webhook Flow

1. Better Auth Creem plugin receives webhook.
2. Backend maps payload to internal team snapshot.
3. Entry is recorded in `billing_webhook_events` with status `received`.
4. Snapshot is synced into `subscriptions` and team plan is updated if needed.
5. Event is marked `processed` / `ignored` / `failed`.
6. Operational alerts are emitted for ignored/failed cases.

## Diagnose Subscription Sync Issues

### 1) Check webhook audit status

Inspect latest webhook records by team or status:

- filter by team id and `received_at desc`
- filter by `status='failed'`

Look at:

- `provider_event_id`
- `event_type`
- `attempt_count`
- `error_code`, `error_message`

### 2) Compare subscription projection with billing account

Verify for a team:

- `subscriptions.status`
- `subscriptions.plan_family`
- `billing_accounts.plan_family`

Expected rule:

- status in `trialing|active|past_due` => team should be `team_standard`
- any other status => fallback to `individual_free`

### 3) Verify scheduler reconcile

Scheduler periodically runs reconcile and auto-realigns mismatched plan families.

If reconcile keeps fixing the same team repeatedly, inspect webhook payload mapping and
provider product metadata.

## Common Failure Scenarios

### A) Webhook ignored (`context_missing`)

Symptoms:

- `billing_webhook_events.status = ignored`
- alert key `billing:webhook:ignored:*`

Likely causes:

- payload missing `teamId` metadata
- payload product id not mapped to `team_standard`

Action:

- verify checkout metadata includes `teamId` and `planFamily`
- verify `CREEM_TEAM_STANDARD_PRODUCT_ID`

### B) Webhook failed

Symptoms:

- `billing_webhook_events.status = failed`
- alert key `billing:webhook:failed:*`

Likely causes:

- DB write failure
- invalid state or runtime config

Action:

- inspect `error_code` and `error_message`
- reprocess from provider side after fix

### C) Team plan mismatch

Symptoms:

- alert key `billing:reconcile:plan-mismatch:<teamId>`
- reconcile reports `realigned > 0`

Action:

- inspect latest subscription status for that team
- ensure webhook events are current and successful

## Webhook Replay Validation

Validate webhook behavior by replaying real provider events from Creem:

1. Trigger checkout or subscription status change in Creem test mode.
2. Replay the webhook event from the provider dashboard.
3. Verify `billing_webhook_events` transitions to `processed`.
4. Verify team plan sync in `billing_accounts` and `subscriptions`.

Recommended checks:

- no duplicate side effects when replaying the same provider event
- `attempt_count` increases while business state remains idempotent
- `ops_alerts` records ignored/failed conditions only when needed

## Recovery and Rollback

If billing is unstable:

1. Disable external subscription writes by setting `BACKEND_TEAM_BILLING_ENABLED=false`.
2. Keep auth and workspace online.
3. Keep collecting webhook audits if needed.
4. Fix mapping/config/database issues.
5. Re-enable team billing and replay provider webhook events.
