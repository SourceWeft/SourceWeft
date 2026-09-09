# Waffo Pancake integration verification — 2026-09-09

## Implemented

- Official documentation snapshot downloaded from https://docs.waffo.ai/llms-full.txt; official skill extracted from https://docs.waffo.ai/integrate/skill and loaded from the ignored local cache at output/references/waffo/SKILL.md.
- @waffo/pancake-ts 0.20.0 installed only in the commercial billing edition. Core source and lockfile remain independent of the SDK.
- BACKEND_BILLING_PROVIDER selects creem or waffo. Waffo requires only WAFFO_MERCHANT_ID and WAFFO_PRIVATE_KEY as new credentials; optional WAFFO_ENVIRONMENT defaults to test. Credentials alone never enable checkout.
- Store/product initialization persists non-secret IDs in PostgreSQL. Multiple stores require explicit selection; existing bindings cannot silently move to another store. Setup checks existing subscription product periods and never publishes production products.
- Existing authenticated checkout APIs create persisted Waffo subscription/top-up orders. Amounts use SDK display strings. Merchant/environment-aware references and expiry checks prevent reusing the wrong checkout session.
- The raw-body webhook endpoint verifies SDK signatures and environment, persists the receipt before returning 200, and processes it through an idempotent order/ledger flow. Background retries survive API restarts. Store/product/order/currency/amount bindings and subscription event ordering are checked.
- Waffo checkout opens in a protected new tab after an explicit user click. Credit/page top-up controls and the official consumer portal are wired into the commercial UI. Unsupported Waffo seat adjustments fail explicitly; Creem remains supported.
- Migration 0031 adds provider settings and extends existing provider constraints without deleting financial history.
- Local checkout and webhook-only ngrok proxy helpers are provided in scripts/e2e/waffo-checkout.mjs and scripts/e2e/waffo-webhook-proxy.mjs.

## Completed local checks

- Commercial billing unit/integration suite: **88 passed**, including SDK request signing, raw signature checks, replay timing, wrong environment/store/product/order/amount cases, durable retry, duplicate fulfillment, expiry refresh, environment isolation, subscription renewal/cancellation ordering, store setup selection and new-tab UI behavior.
- Real PostgreSQL suite: **2 passed**, including concurrent duplicate Waffo receipts processed by independent service instances, one-time credit granting and settings isolation.
- Existing Web suite: **580 passed**.
- Full core workspace type checks: **40 tasks passed**. Commercial billing/backend/Web type checks passed.
- Core lint and changed commercial UI lint: passed; changed UI has zero warnings.
- Core and commercial Web/backend builds: passed (backend includes API, worker and scheduler).
- Auth/Drizzle migrations applied successfully to an isolated sourceweft_billing_test_waffo database.
- Fresh core/commercial source dependency boundary checks and six source-preparation tests passed. Fresh commercial frozen installation passed.
- Commercial npm audit: zero reported vulnerabilities. SDK and test dependencies were installed using the repository's pinned pnpm 10.19.0.

Tests using the official SDK's transport mock or a generated test signing key are local integration tests. They are **not** evidence of a live Waffo payment.

## Not yet completed: real test checkout

The user's Mac remained locked on both computer-use checks, so the Dashboard could not be accessed. Consequently no real Merchant ID was copied, no TEST API Key was created, no live Waffo store/product/webhook was configured, card 4576750000000110 was not submitted, and a vendor-signed order.completed event has not been observed.

Continuation requires the Mac to be unlocked and Waffo's test Dashboard to be available. Then obtain the Merchant ID from API & Development (not storeId), create the TEST key, place the two credentials in the ignored environment file, initialize the catalog and ngrok webhook, and use the provided create/verify helper around the real card checkout. Its verify mode requires a processed order.completed receipt, paid/fulfilled local order and exactly one ledger grant.

Prepared local test workspace: /private/tmp/sourceweft-waffo-commercial. Task-only PostgreSQL is bound to 127.0.0.1:55449 and Redis to 127.0.0.1:56399. API/Web/webhook proxy ports are 3541/3542/3543. No production deployment or live transaction is claimed. The full checkout requirement remains open until the real flow is verified.
