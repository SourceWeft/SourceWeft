# SourceWeft Billing

The commercial billing application-service package. Core execution depends on
`@sourceweft/contracts/billing-runtime`; it does not load this package. Core
runs without credit/page billing, while retaining authorization, resource limits
and provider usage/cost observations. This package is not an agent capability.

## Entry points

- `/server`: billing services and execution adapter, with explicit host ports.
- `/postgres`: store accepting a caller-owned Pool and membership query source.
- `/config`: explicit environment reader and enabled-feature validation.
- `/integrations/http`: authenticated billing route factory.
- `/integrations/auth`: runtime or schema-only Creem plugin factory.
- `/integrations/creem`: webhook synchronization and scheduled-cancel handler.
- `/integrations/jobs`: subscription/order reconciliation schedule factory.
- `/ui`: billing, usage, checkout, pricing and sidebar components; requires an
  explicit BillingUiProvider containing host SDK/auth/UI adapters.
- `/catalog`: concrete pricing presentation, isolated from open contracts.
- `/auth-client`: Creem client plugin contribution for commercial builds only.

Database structure and historical migrations remain owned by the open DB
package. This store imports `@sourceweft/db/schema`, not the DB singleton. The
host owns Better Auth member/invitation tables and passes its query adapter,
including the same PoolClient when a billing transaction is active.

The commercial projection also restores the backend `creem:product:create` and
`creem:product:delete` operator commands; core does not include these commands.

## Core and commercial builds

The repository source is the core edition. Prepare a separate commercial source
workspace before installing dependencies:

```sh
node scripts/editions/prepare.mjs --edition=commercial --out=/private/tmp/sourceweft-commercial
```

In the prepared workspace:

```sh
pnpm install --frozen-lockfile
pnpm --filter @sourceweft/market-contracts build
pnpm --filter @sourceweft/ui-web build
pnpm --filter @sourceweft/backend check-types
pnpm --filter web check-types
pnpm --filter @sourceweft/billing check-types
pnpm --filter @sourceweft/billing test
pnpm --filter @sourceweft/billing test:database
```

Database tests require an isolated `sourceweft_billing_test*` database with the
actual migrations applied. Unit tests need no backend environment, database or
payment credentials. The source preparation script excludes secrets, installed
modules and build artifacts. Existing generated output is replaced only with
`--replace=true`, which explicitly deletes that generated workspace.

The commercial projection contributes application dependencies, runtime/Auth/UI
bindings and operator scripts. It uses its own committed lockfile; its Creem SDK
is pinned to the pre-extraction version. Lockfile maintenance uses
`--refresh-lockfile=true` and pnpm's normal lockfile generation, followed by
saving the generated lockfile in `edition/pnpm-lock.yaml`. CI never refreshes it.

A core build cannot be converted by setting a key or runtime environment.
`SOURCEWEFT_EDITION`, when supplied, must match the built edition. Explicit
billing activation in a core build fails. Enabled commercial checkout validates
credentials and configured products; it never falls back to unmetered core.
Front-end checkout flags can further restrict what the server enables.

Docker builds select `--build-arg SOURCEWEFT_EDITION=core` (default) or
`--build-arg SOURCEWEFT_EDITION=commercial`. The source projection is pruned
before building; root and commercial license files are explicitly preserved.
Use matching API, worker, scheduler and Web images/configuration.

## Migration and compatibility

Run the edition's Auth migration, shared Drizzle migration, then the existing
extension OAuth provisioning command. Commercial Auth migration includes
Creem's schema without registering runtime webhook side effects. No historical
application migration is rewritten and no billing table is renamed or moved.

Core preserves historical billing tables but does not create accounts or write
ledger entries. Switching an operating commercial deployment to core is an
explicit cessation of billing: finish or isolate pending jobs/webhooks, arrange
existing subscriptions and retain financial data first. Do not use core as an
automatic commercial failure recovery mode. Rollbacks use the previous
commercial build and preserve already-confirmed payments and ledger rows.

## License and verification

See [LICENSE](LICENSE) and [enterprise LICENSE](../LICENSE). They must remain
identical. Applicable previous Apache-2.0 permissions remain in effect; see
[Apache-2.0](LICENSES/Apache-2.0.txt). `private` prevents accidental publication;
it is not a runtime licensing system. Production rights are governed by the
commercial agreement, independently of customer payment subscriptions.

The implementation's selected verification and remaining external-service
coverage limits are recorded in `docs/verification/billing-extraction/completion.md`.
This change does not execute production deployment or live payment transactions.
