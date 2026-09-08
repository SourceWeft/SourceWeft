# Billing extraction implementation progress

Base: d33c9df5
Branch: codex/billing-package-extraction

- T00: started; isolated worktree created, locked dependency installation next.
- T01–T12: pending.

No production database, payment or deployment action authorized or performed.

## T00 baseline
- Fresh frozen install: passed (40 workspace projects).
- Temporary PostgreSQL: sourceweft-billing-test-db, 127.0.0.1:55439; Redis: sourceweft-billing-test-redis, 127.0.0.1:56389.
- Auth + Drizzle migration: passed after exporting the same test environment to both commands.
- Backend typecheck: passed after building the existing market-contracts prerequisite.
- Targeted backend baseline plus core policy tests: 88 passed.
- Contracts suite including new runtime/capability tests: 125 passed.
- Earlier missing env and sandbox EPERM failures were resolved by the documented isolated environment and tool approval, not by replacing test strategies.

## Implementation
- T01: runtime contracts, capability schema, SDK client and tests added; backend call-site migration pending.
- T02: core policy implemented and tested; startup binding/config integration pending.
- T03: commercial services copied for differential validation; original services still present temporarily. Dependencies inverted for organization provisioning, logger, config and Postgres pool.
- Commercial source projection prepared; first dedicated lockfile generation in progress.

## First extraction checkpoint (2026-09-09)

Completed evidence:
- Independent commercial frozen installation: passed; existing importer resolutions unchanged.
- Standalone package baseline: 63 existing tests passed without a backend environment.
- Runtime charging/BYOK/idempotency and missing-host factory tests added.
- Real PostgreSQL: concurrent identical requests charge once, member isolation and failure-after-ledger rollback passed.
- Core policy/config tests: 5 passed.
- SDK typecheck and 2 existing SDK tests passed.
- Source-projection tests cover missing enterprise, secret omission, explicit replacement, stale-file removal and source-path protection.
- Commercial source scan has no app/shared-module imports.

Remaining (implementation is NOT complete):
- Switch backend call sites from ContentBillingPort/getSummary to the new execution runtime and remove originals.
- Wire startup bindings, Auth/HTTP adapters, lifecycle hooks, observation and job integrations.
- Move catalog/default policy out of open packages and finish strict commercial startup validation.
- Move billing UI and Creem client; implement core capabilities/UI behavior.
- Complete core/commercial dependency manifests, bindings, Docker/CI and fresh core install proof.
- Expand migration/BYOK/payment sandbox/full acceptance and rollback checks.
- Complete provenance review and official commercial publication approval.

The legacy backend remains active in the source worktree at this checkpoint.
Temporary testing services are isolated: sourceweft-billing-test-db and sourceweft-billing-test-redis.
The ignored backend .env contains only this task's temporary test credentials; it must never be committed or copied into release projections.
