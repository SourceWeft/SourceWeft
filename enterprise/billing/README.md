# SourceWeft Billing

The commercial billing application-service package. Core execution depends on
`@sourceweft/contracts/billing-runtime`; the module switch gates loading this package. Core
runs without credit/page billing, while retaining authorization, resource limits
and provider usage/cost observations. This package is not an agent capability.

## Entry points

- `/server`: billing services and execution adapter, with explicit host ports.
- `/postgres`: store accepting a caller-owned Pool and membership query source.
- `/config`: explicit environment reader and enabled-feature validation.
- `/integrations/http`: authenticated billing route factory.
- `/integrations/creem`: webhook synchronization and scheduled-cancel handler.
- `/integrations/jobs`: subscription/order reconciliation schedule factory.
- `/ui`: billing, usage, checkout, pricing and sidebar components; requires an
  explicit BillingUiProvider containing host SDK/auth/UI adapters.
- `/catalog`: concrete pricing presentation, isolated from open contracts.

Database structure and historical migrations remain owned by the open DB
package. This store imports `@sourceweft/db/schema`, not the DB singleton. The
host owns Better Auth member/invitation tables and passes its query adapter,
including the same PoolClient when a billing transaction is active.

The unified workspace includes the backend `creem:product:create` and
`creem:product:delete` operator commands; core does not include these commands.

## One source tree, optional commercial module

Develop, build and run from the repository root. The workspace and its single
lockfile include `enterprise/billing`; no source projection, template replacement,
separate checkout, or edition-specific image is required.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The API, worker and scheduler read the same backend environment. Set this in
`apps/backend/.env` locally, or the Compose `.env` for deployment:

```dotenv
SOURCEWEFT_COMMERCIAL_ENABLED=false
```

Unset defaults to false. Only true/false/1/0 are accepted, ignoring case and
surrounding whitespace. Credentials never enable the module. Enabling a child
billing feature with the module disabled is a configuration error. Remove the
old `SOURCEWEFT_EDITION` selector; it does not activate a module.

For local billing evaluation without payment credentials:

```dotenv
SOURCEWEFT_COMMERCIAL_ENABLED=true
SOURCEWEFT_SAAS_ENABLED=false
BACKEND_BILLING_PROVIDER=none
BACKEND_BILLING_MODE=shadow
```

This runs real usage/account/ledger logic. Shadow mode records usage without
credit enforcement; use enforced to test balance checks. It does not simulate a
successful payment or claim payment-provider validation.

For a provider's test checkout, keep commercial enabled, set
`SOURCEWEFT_SAAS_ENABLED=true`, select `BACKEND_BILLING_PROVIDER=creem`, `stripe`
or `waffo`, and configure that provider's test credentials, signed webhook and
product catalog. Use `CREEM_TEST_MODE=true`, `STRIPE_TEST_MODE=true`, or
`WAFFO_ENVIRONMENT=test`, respectively. Missing required configuration fails
startup; the application never switches provider or falls back to unmetered mode.

To handle Waffo refunds, add `refund.succeeded` and `refund.failed` to the
event list of the store's existing Waffo webhooks — both the test-mode and
the live endpoint — in the Waffo dashboard or with `client.webhooks.update`;
`setup-waffo --webhook-url` creates a new test-mode webhook and does not
update an existing one. Add the events only once every API, worker and
scheduler instance runs a version that handles them: an older instance marks
a refund receipt ignored as unsupported, and receipt dedupe means Waffo never
redelivers it once acknowledged, so a refund event seen before the rollout
finishes is a refund silently not reversed. Verify the refund payload in the
Waffo test environment first — a full refund and two successive partial
refunds on one payment — before adding the events to the live endpoint.

To handle Creem refunds and disputes, a Creem endpoint configured with an
explicit event list must include `refund.created` and `dispute.created` (an
endpoint with an empty event list already receives every event type,
including these). Enable the events only after every API, worker and
scheduler instance runs a version that handles them, for the same reason as
Waffo above. Before enabling on the live endpoint, verify in Creem test mode
with a full refund and two successive partial refunds on one taxed payment
that `transaction.refunded_amount` is a cumulative total that includes the
current refund (not just this event's own `refund_amount`), and that
`transaction.amount_paid` is the tax-inclusive amount actually paid, not the
pre-tax `amount` (Creem's own example: `amount` 1000, `amount_paid` 1210,
`tax_amount` 210).

Restart API, worker and scheduler together after changing module settings. Their
startup capabilities must agree. The same image supports both states. Web and PC
read `/v1/deployment/capabilities` at runtime; obsolete
`NEXT_PUBLIC_SOURCEWEFT_SAAS_ENABLED` and `NEXT_PUBLIC_BILLING_CHECKOUT_ENABLED`
are unused and can be removed. Capability-loading errors are shown, not treated
as a disabled commercial module. Reload open clients after a deployment switch.

When disabled, the commercial backend module is not imported, payment SDKs and
commercial jobs are not initialized, and no billing accounts/ledger writes occur.
Authentication, authorization, core resource limits and cost observations remain.
Commercial UI loads on demand only after the server reports it available; direct
billing routes remain gated on the server as well as the client.

The unified image includes separately licensed commercial code and notices. The
repository root license does not replace `enterprise/LICENSE` or package notices.

Verify using the normal workspace commands, the module-mode CI matrix, and
`node scripts/editions/check-boundaries.mjs`. PostgreSQL tests still require an
isolated `sourceweft_billing_test*` database.

## Migration and compatibility

Run the edition's Auth migration, shared Drizzle migration, then the existing
extension OAuth provisioning command. Billing registers no Better Auth plugins;
shared billing migrations are applied independently of the module switch. No historical
application migration is rewritten and no billing table is renamed or moved.

Core preserves historical billing tables but does not create accounts or write
ledger entries. Switching an operating commercial deployment to core is an
explicit cessation of billing: finish or isolate pending jobs/webhooks, arrange
existing subscriptions and retain financial data first. Do not use core as an
automatic commercial failure recovery mode. Rollbacks use the previous
commercial build and preserve already-confirmed payments and ledger rows.

## License and verification

See [LICENSE](LICENSE) and [enterprise LICENSE](../LICENSE). They must remain
identical. `private` prevents accidental publication; it is not a runtime
licensing system. Production rights are governed by the commercial agreement,
independently of customer payment subscriptions.
