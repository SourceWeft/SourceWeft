# billing module

Current Team V1 billing scope:

- team-scoped `pages + credits` metering
- PostgreSQL-backed billing accounts, subscriptions, and usage ledger
- Creem-backed `team_standard` subscription lifecycle (checkout/portal/cancel)
- webhook processing with audit log (`billing_webhook_events`)
- periodic reconcile for team plan consistency

This module is team-scoped and uses Better Auth organization membership for access control.
