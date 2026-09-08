# Unified AnyDoc format E2E

This supplements the historical [initial runbook](anydoc.md). The unified
implementation has no local parser selector. Use parser version
`v4-anydoc-unified-0.2.4`; remove `DOCUMENT_PARSE_PROVIDER` and
`DOCUMENT_PARSE_STRATEGY` from the isolated environment. Keep the deployment's
existing model gateway configuration unchanged.

Use the existing environment helper to preflight, prepare, and later drop a
fresh isolated database. API 3101, Web 3100, and the dedicated queue keep the
original checkout independent. Build required workspace runtime outputs before
starting. Native watcher exhaustion may require the previously documented
`WATCHPACK_POLLING=true` with the same Next development command.

For this native-format acceptance run, explicitly set
`DOCUMENT_PARSE_OCR_ENABLED=false`. Before any additional paid OCR submission,
check the previously pending external task. Pending external work is a blocker
for OCR completion evidence, not permission to silently change OCR providers.

## Actual user journey

Register a fresh test account through the normal UI. Upload representative new
formats (XLSX, RTF and ODT) together with DOCX and the two-page text PDF; include
other newly supported format fixtures when available. Record which real upload
transport the UI chooses. Verify every successful source uses AnyDoc, is indexed,
and retains its fixture's unique words and values. Select the sources in a real
chat, request source-tool retrieval and verify returned numeric values and
clickable citations. Open a citation to verify it resolves to the uploaded
source rather than merely containing matching answer text.

Upload the known scanned-PDF fixture under the disabled OCR policy and verify
an actionable failure with no OCR task. Do not label that check as live OCR
completion. Read-only historical task status and existing async automated tests
are separate evidence.

## Manifest-driven API checks

Create an ignored JSON manifest with the fresh workspace/source UUIDs returned
by the actual UI upload. For example:

```json
{
  "workspaceId": "00000000-0000-0000-0000-000000000001",
  "parserVersion": "v4-anydoc-unified-0.2.4",
  "cases": [
    {
      "sourceId": "00000000-0000-0000-0000-000000000002",
      "fileName": "sample.xlsx",
      "detectedFormat": "xlsx",
      "contains": ["fixture phrase", "1234.56"]
    },
    {
      "sourceId": "00000000-0000-0000-0000-000000000003",
      "fileName": "scan.pdf",
      "expectedError": "DOCUMENT_PARSE_OCR_ENABLED is false"
    }
  ]
}
```

Use actual IDs and fixture expectations, not these illustrative values. Set
`E2E_CASES_PATH`, `E2E_EMAIL`, and `E2E_PASSWORD` in the process environment. From
`apps/backend`:

```sh
pnpm exec tsx src/scripts/anydoc-formats-e2e-assert.ts assert
```

Every manifest case is checked independently; failures are recorded and cause
nonzero exit. Successful native cases must have indexed chunks and actual
AnyDoc engine/route diagnostics. No case may create a new OCR task in this run.
Optional `estimatedPages` and `pageCount` expectations check billing and physical
totals without inventing page locations. Results contain selected non-secret
fields in `output/playwright/anydoc-formats/api-assert-results.json`.

Before deleting the database, stop the dedicated worker and clean up the exact
manifest sources and storage prefixes:

```sh
E2E_DELETE_SOURCE_OBJECTS=true pnpm exec tsx src/scripts/anydoc-formats-e2e-assert.ts cleanup
```

Then stop the isolated API/Web/browser, remove only the two dedicated queues,
and run the existing environment helper's cleanup. Keep private traces and
screenshots ignored. Record the final live evidence and any remaining blockers
in `anydoc-unified-verification.md`; retain the earlier report as history.

## Supplementary production-worker check

After the real chat finishes, stop only the dedicated development worker and
start `node dist/worker.js` with the same private environment/database/queue.
Successful-source UI menus offer Re-index, which does not invoke parsing; the
reparse check therefore uses the real authenticated reparse API and verifies a
new indexed revision:

```sh
E2E_REPARSE_FILE=sample.epub pnpm exec tsx src/scripts/anydoc-formats-e2e-assert.ts reparse
```

The runner triggers only the selected known successful fixture, waits at most
60 seconds for a new indexed revision, then reruns all manifest assertions.
Check the built worker log for the corresponding source-parse job. This is
additional production-artifact evidence, not a replacement for browser upload
and retrieval coverage.
