# AnyDoc page-billing verification — 2026-09-08

## Verified rule

This run verifies the existing central ingestion billing rule and corrects the
Office/CSV/EPUB accounting expectations recorded in the earlier AnyDoc reports:

1. Use a trustworthy physical page count when available.
2. Otherwise estimate tokens as `ceil(parsedContent.length / 4)` and charge
   `max(1, ceil(tokens / 1000))` standard text pages.

File count, CSV record count and EPUB chapter count are not billable page counts.
The expected values below were computed independently from the content returned
by the real source-content API, without importing the implementation resolver.
Actual consumption was read from the authenticated billing ledger, not inferred
from parser metadata or `estimatedPages`.

## Real upload → indexing → ledger results

A fresh test account uploaded four fixtures through the normal browser file
picker and multipart upload path. AnyDoc parsed them, the unchanged configured
embedding service indexed them, and the ordinary billing service wrote page
consumption entries.

| Fixture                         | Parsed characters | Estimated tokens | Physical pages | Expected charge | Actual page ledger delta | Consumption rows |
| ------------------------------- | ----------------: | ---------------: | -------------: | --------------: | -----------------------: | ---------------: |
| Long RTF without physical pages |            13,288 |            3,322 |           None |               4 |                       -4 |                1 |
| CSV with one long data record   |             5,956 |            1,489 |           None |               2 |                       -2 |                1 |
| EPUB with one long chapter      |             6,582 |            1,646 |           None |               2 |                       -2 |                1 |
| Short real two-page PDF         |                72 |               18 |              2 |               2 |                       -2 |                1 |

All four sources were indexed. Their source estimates also matched the ledger,
but the authoritative assertion was each actual ledger `delta`. The PDF's small
text would be one standard text page; its real two-page count correctly wins.
The one-record CSV and one-chapter EPUB both consumed two pages, disproving the
removed record/chapter accounting rule. Total consumption was **10 pages**.

The script queried `/v1/teams/:teamId/billing/ledger` using the newly created
personal-team owner's authenticated session. It selected only that actor's
`unitType=page`, `eventType=consume` entries with the exact test workspace and
`referenceId=source:<sourceId>`. No ledger/account rows were manually inserted,
updated or corrected.

## Original-key replay and balance proof

The original job key was taken from each actual source's `metadata.jobId`. Code
inspection established the full path: source enqueue sets BullMQ job ID to its
idempotency key; that same key is passed through parsing and indexing to
`meterIngestion`; the ledger stores it as `<actorUserId>:<originalKey>`.
The runtime test required the stored ledger key to match this exact relationship
before any replay was attempted.

Each source then received **two authenticated `/sources/:id/index` calls** with
that verified original key: eight replay calls in total. After replay:

- Each source still had its single original page-consumption row.
- The complete actor-scoped page-ledger row IDs, deltas, balances and keys were
  identical to the pre-replay snapshot.
- Account `used` and `consumedThisCycle` remained **10**.
- Account `remaining`, `monthlyBalance` and `available` remained **290** out of
  the existing 300-page grant.

Both the initial ledger assertion and the eight-call replay run returned
`passed: true`. Replay used the public indexing API; it did not call a billing
mock or modify the ledger to arrange the expected result.

## Scope and environment

The run used the existing isolated setup: API 3101, Web 3100, a fresh migrated
test database, a dedicated queue and a new example.invalid account. The original
custom model gateway configuration was unchanged. No new chat was started and
no remote OCR task was submitted; OCR was disabled for this test round.

Fixtures were generated with Python's standard library. The RTF exceeds 8,000
parsed characters; CSV and EPUB exceed 4,000 despite having exactly one record
and one chapter. The PDF copies the repository's real two-page sample. Parser
version remained `v4-anydoc-unified-0.2.4` on the same unreleased branch.

The coordinating agent completed 69 parser-package tests and 182 backend tests
covering sources/config and the billing-service memory-store suite. Backend
formal build passed. The new live-ledger helper passed backend build typecheck.
The real HTTP ledger results above are separate evidence from those tests.

## Reproduction and artifacts

Generate the four inputs:

```sh
python3 scripts/e2e/generate-anydoc-billing-fixtures.py
```

After real UI upload, construct an ignored manifest containing the actual test
team/workspace/source IDs, version, filenames, minimum parsed-character
thresholds, and the known PDF page count. Set `E2E_EMAIL`, `E2E_PASSWORD`, and
`E2E_BILLING_CASES_PATH`; then run from `apps/backend`:

```sh
pnpm exec tsx src/scripts/anydoc-billing-e2e.ts assert
pnpm exec tsx src/scripts/anydoc-billing-e2e.ts replay
```

The first mode is read-only. Replay calls the ordinary indexing route using only
keys already verified against the actual ledger. Both write selected non-secret
results to the ignored `output/playwright/anydoc-billing/` directory:

- `ledger-assert-results.json`: parsed lengths, independently expected charges,
  actual deltas and balances.
- `ledger-replay-results.json`: the same four charges, eight replay calls and
  unchanged before/after account page balances.
- `indexed-sources.png`: the actual uploaded-source UI.
- `api-cleanup-results.json`: four successful source/object cleanups.
- Private browser traces and service logs, retained locally without publication.

For source/object cleanup, use the existing manifest-driven cleanup helper with
`E2E_DELETE_SOURCE_OBJECTS=true` and `E2E_ARTIFACT_SUBDIR=anydoc-billing` so its
receipt stays in this round's artifact directory. The output subdirectory now
accepts only a simple bounded name. During this run the helper's earlier fixed
output path overwrote the prior format-run cleanup JSON; the current four-case
receipt was moved unchanged to the correct directory, and the old receipt was
marked unavailable. No prior audit receipt was reconstructed. Earlier tool
history and reports remain the evidence of the earlier cleanup.

## Cleanup

All four test source records and their exact bounded S3 prefixes were deleted.
The worker, API, Web and browser were stopped; both dedicated queues were removed
without force and the isolated database was dropped. The temporary OCR flag was
restored after the worker stopped. The original services on ports 3000/3001 were
left unchanged. Historical reports were not rewritten to pretend their earlier
billing expectations were correct; this report documents the correction.
