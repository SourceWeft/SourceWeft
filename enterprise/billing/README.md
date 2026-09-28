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
Waffo above. Verified in Creem test mode on one untaxed $5.00 payment with
three successive partial refunds: the embedded `transaction` object on a
`refund.created` event is a snapshot taken BEFORE the current refund, so
`transaction.refunded_amount` is the cumulative total of the earlier
refunds only — null when there were none, and in every observed event not
a total that already includes this event's own `refund_amount`. Each
refund is therefore reversed by its own `refund_amount`;
`transaction.refunded_amount` is used only as a sanity check against
`transaction.amount_paid`, never as the reversal amount. Creem documents
`transaction.amount_paid` as the tax-inclusive amount actually paid, not
the pre-tax `amount` (Creem's own example: `amount` 1000, `amount_paid`
1210, `tax_amount` 210) — the observed payment above had no tax, so this
distinction was not itself exercised. Before enabling `refund.created` on
the live endpoint, verify on a taxed Creem test payment that one full
refund's `refund_amount` equals `transaction.amount_paid`, and that two
successive partial refunds on the same payment sum to it.

To handle Stripe refunds and disputes, add `charge.refunded`,
`charge.dispute.created` and `charge.dispute.closed` to the enabled events of
the Stripe webhook endpoint — both the test-mode and the live endpoint — in
the Stripe Dashboard or with `webhookEndpoints.update`. That call replaces
`enabled_events` as a whole: pass the endpoint's existing events plus the
three (every event in `STRIPE_WEBHOOK_EVENTS`). Passing only the three new
ones stops checkout, invoice and subscription events, and with them
fulfilment. Enable the events only after every API, worker and scheduler
instance runs a version that handles them, for the same reason as Waffo above:
an older instance marks these receipts ignored, and receipts of these types
stored earlier (for example by an endpoint that already sends every event) are
not replayed, so review refunds and disputes from before the rollout by hand.
A restricted key (`rk_…`) needs read access to PaymentIntents, Invoices,
Invoice Payments and Subscriptions to match a refund or dispute to its order;
without it Stripe answers 403, which is treated as transient, so the receipt
fails and is retried until that access is granted.

A Stripe refund reverses the refunded share of a top-up from the charge's
cumulative `amount_refunded` against its `amount`. A refund that fails after
it was reversed is not detected at all — Stripe reports that with
`refund.failed` and `charge.refund.updated`, which are not subscribed — so its
reversal stays and must be re-granted by hand; a later `charge.refunded` with
a lower total changes nothing. An opened dispute only raises an alert; a
closed dispute reverses the whole top-up only when it is lost. A refund or
lost dispute on a subscription payment changes no balance and raises an alert
instead. A refund or dispute on a charge this deployment did not sell — on an
account that also sells other products, or a test account shared by several
deployments — raises an error-level unmatched alert. Before enabling on the
live endpoint, verify in Stripe test mode with a full refund, two successive
partial refunds on one payment and a lost dispute.

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
