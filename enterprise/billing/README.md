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
- `/integrations/waffo`: SDK-backed Waffo adapter, durable webhook inbox and HTTP handler.
- `/waffo-setup`: test store/product bootstrap with explicit store selection.
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

## Waffo Pancake (test environment)

Use the commercial source projection and the normal database migrations. Select
`BACKEND_BILLING_PROVIDER=waffo`; existing `SOURCEWEFT_SAAS_ENABLED=true` and Web
checkout flags still control whether payments are exposed. Keep `creem` to use
the existing Creem integration. Credentials alone never select a provider.

Waffo adds exactly two required credentials:

```dotenv
WAFFO_MERCHANT_ID=MER_yourMerchantId
WAFFO_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

Get the **Merchant ID** using the copy button at the top of Dashboard → API &
Development, then create a **TEST API Key** in API Keys. Do not substitute a
Store ID. The key determines the API environment. `WAFFO_ENVIRONMENT` defaults
to `test` and controls webhook verification; it must match the key. No store ID,
product ID or webhook signing secret is required as an environment variable.
Private keys remain server-side and must not be committed or logged.

In the prepared commercial workspace, initialize non-secret store/product
bindings in PostgreSQL:

```sh
pnpm --filter @sourceweft/backend db:migrate
pnpm --filter @sourceweft/backend waffo:setup
# If the merchant has multiple stores, inspect the reported choices and use:
pnpm --filter @sourceweft/backend waffo:setup --store-id=STO_selectedStore
```

The setup command lists stores first, creates one if none exist, automatically
uses the sole store, and requires an explicit choice for multiple stores. It
keeps an existing merchant/environment store binding stable, creates/reuses tagged subscription and top-up products and never publishes to
production. Production product promotion and binding require a separate,
explicit rollout; this initial setup command is test-only.

Checkout uses the existing authenticated pricing/top-up endpoints. Waffo checkout
opens in a new tab after a user click, preserving the merchant page and avoiding
popup-blocker-dependent automatic navigation. Subscription management uses
Waffo's official consumer portal. Seat quantity changes are not implemented by
the SDK adapter and return `WAFFO_SEAT_UPDATE_UNSUPPORTED`; no Creem fallback is
performed. Existing subscriptions retain their provider. Switching the selected
provider does not migrate them: keep the old provider deployment handling its
active subscriptions/webhooks until that migration is explicitly completed.

The Waffo webhook endpoint is `POST /v1/billing/webhooks/waffo`. It verifies raw
body signatures with the SDK's embedded environment key, checks store and mode,
persists the receipt, and only then returns 200. Background processing validates
order/product/currency/amount bindings and uses the existing idempotent ledger.
The scheduler retries durable receipts after process interruption. Subscription
periods come from domain events, never from charge-only events or a fabricated
local period.

### Full local checkout verification

Use a separate `sourceweft_billing_test*` database and local API/Web ports. The
test environment in this task uses API 3541, Web 3542 and webhook proxy 3543.
After starting the API and scheduler with the TEST key:

```sh
node scripts/e2e/waffo-webhook-proxy.mjs
ngrok http 3543
pnpm --filter @sourceweft/backend waffo:setup --webhook-url=https://YOUR-NGROK-HOST/v1/billing/webhooks/waffo
node scripts/e2e/waffo-checkout.mjs create
```

The tunnel forwards only the exact webhook POST route and preserves the raw
body and signature header. The create command provisions a disposable local
account and creates a page-pack checkout via the project's authenticated API.
It stores the test session in an ignored, owner-only file. Open the returned
checkout URL and pay with **4576750000000110**, any future expiry and any CVC.
Then run:

```sh
node scripts/e2e/waffo-checkout.mjs verify
```

Verification requires the real `order.completed` receipt to be processed, the
local order to be paid/fulfilled, and exactly one entitlement grant in the test
database. Signed fixture tests are separate and do not count as real checkout.

Official sources: [full documentation](https://docs.waffo.ai/llms-full.txt),
[official skill](https://docs.waffo.ai/integrate/skill), and the types/guides shipped
with `@waffo/pancake-ts@0.20.0`. The current SDK omits the older `productType` and
`taxIncluded` checkout parameters; amounts are USD display strings, not cents.
