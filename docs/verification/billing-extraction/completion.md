# Billing extraction verification — 2026-09-09

## Implementation

The backend billing directory has been removed. Core execution uses the open BillingRuntime interface; billing UI, payment integration, pricing policy and transaction code live in enterprise/billing. Shared database schema and historical migrations remain unchanged. Core has no commercial account/ledger operations and no required Creem dependency.

Core and commercial builds are explicit source projections with separate frozen lockfiles. Commercial host bindings are generated only for the commercial edition. Missing commercial dependencies or invalid enabled configuration do not fall back to core. Existing customer billing rules, per-member balances and idempotency keys are preserved. Auth membership queries are host-injected and retain the caller's PoolClient.

## Completed checks

- Core fresh frozen install from a projection without enterprise: passed.
- Commercial frozen install: passed; Creem SDK pinned to baseline 1.6.0.
- Core and commercial source dependency boundary checks: passed.
- Final core and commercial API/worker/scheduler builds: passed. Both editions also passed actual worker/scheduler startup probes.
- Core and commercial Web type checks and builds: passed; final builds repeated after synchronization.
- Web suite: 80 files / 580 tests passed.
- Targeted backend billing/BYOK/network regression: 91 tests passed.
- Durable-run / embedding-identity PostgreSQL suites: 40 tests passed.
- Catalog-sync / local-no-auth / deliverable-host suites: 25 tests passed.
- Final cost-resolution / billing-scope regression: 59 tests passed.
- PostgreSQL store test: passed concurrent idempotency, member balance isolation and rollback after ledger insertion.
- Host membership-source test: passed caller-transaction and bound-parameter checks.
- Final commercial unit suite: 70 tests passed.
- Changed Web files: ESLint passed with zero warnings.
- Source preparation: 6 tests passed, including missing commercial bindings and version/script overlays.
- Local baseline compatibility: old d33c9df5 and new commercial API read identical balances without changing ledger rows.
- Core and commercial API E2E: 9 checks passed for each edition.
- Core browser: real login, Dashboard, team creation and member list, Billing unavailable page passed at the initial extraction checkpoint (superseded by the UI refinement below).
- Core/commercial turbo-pruned source and license layout: passed.
- Core migration and commercial schema-only migration: passed; historical Drizzle files unchanged.

Counts above describe individual runs and overlap; they must not be added into one total.

## API E2E coverage

Each edition's real local API handled signup/session establishment, personal organization/workspace provisioning, team/workspace creation, cross-tenant access rejection, authenticated billing response, and direct PostgreSQL confirmation of the account boundary. Core produced no billing accounts for the new user; commercial persisted accounts and returned its real credit summary.

The committed runner is scripts/e2e/billing-editions.mjs. It restricts targets to localhost and sourceweft_billing_test* databases, uses example.invalid email addresses, and never submits payment checkout. The browser flow used a separate Playwright session, not the user's existing browser profile.

## Failures investigated and fixed

- Missing fresh-worktree environment and an unbuilt shared package were resolved using an isolated test database and the repository's normal prerequisite builds.
- Sandbox EPERM runs were repeated with explicit local-test permissions; they were not counted as passes.
- The broader concurrent database batch hit setup timeouts during host contention and was stopped. The affected suites were then run serially with the same fixtures and assertions and passed.
- Moved test mocks, portable export types, client directive ordering, and an operator-script import were corrected.
- A transitive Creem upgrade during commercial lock regeneration was reverted by pinning the original version.
- The original embedding/rerank no-price-lookup behavior is explicitly covered after moving charging policy into the package.

## Coverage limits

No external Creem transaction or live paid-model generation was performed. Provider transport and BYOK behavior were covered by the existing isolated integration fixtures, not presented as live-provider E2E. The new CI workflow is configured but has not been executed remotely in this task. A complete Docker image pull/build and production deployment were not performed; local application builds and Docker prune/license input layout were verified.

The local baseline compatibility check passed: d33c9df5 read the new commercial account balances, and switching reads back to the new API left balances and ledger rows unchanged. Final core/commercial frozen verification, refreshed backend builds and Web type checks passed. Both editions' actual worker and scheduler startup probes passed. The commercial suite finished with 70 passing tests. Changed Web files passed ESLint with zero warnings. Production infrastructure rollback and live external transactions were not exercised. This work does not revoke pre-existing Apache grants and does not claim that a production commercial agreement has been signed.

## UI refinement — 2026-09-09

Core billing and quota entries are hidden on desktop/mobile and in loading skeletons. No billing-unavailable notice or replacement usage prompt is rendered. The initial redirect handling for old billing/checkout URLs was removed in the route cleanup below. The commercial catalog binding keeps these entries available. This refinement was checked with both edition type checks and the 580-test Web suite; it does not claim a new browser run.

## Historical route cleanup — 2026-09-09

Removed the core billing page directory, redirect compatibility, client re-export wrappers and unused core checkout/success components. Commercial edition templates now generate the checkout and success pages directly, preserving their URLs and query parameters. Core no longer registers those pages; the shared loading shell renders billing skeletons only for the commercial edition.

Both editions were freshly projected and passed the source boundary check, which now requires billing pages to be absent in core and present in commercial. Core and the updated installed commercial workspace passed Web type checks. The 80-file / 580-test Web suite, six source preparation tests and ESLint on changed/generated Web files passed. This cleanup did not repeat browser E2E or production builds; earlier E2E coverage is recorded above.
