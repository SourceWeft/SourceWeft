# AnyDoc live E2E

Run in a dedicated worktree. The existing application must continue using its
own ports, database and queue. Do not use a passing mocked provider test as
proof of successful live OCR or retrieval.

## Environment

Install the workspace dependencies and build the exported runtime artifacts:

```sh
pnpm --filter @sourceweft/market-contracts build
pnpm --filter @sourceweft/ui-web build
```

Privately copy the local backend `.env`
and web `.env.local` into the worktree, preserving the configured model gateway
file and credentials. Do not commit environment files or browser session state.
Set both public URLs to `http://localhost:3100` (web) and
`http://localhost:3101` (API). Set backend `BACKEND_API_PORT=3101`, `PORT=3101`
and `JOB_QUEUE_NAME=sourceweft-anydoc-e2e`. Enable AnyDoc using the documented
parser configuration; keep the explicitly selected OCR and model providers.

From `apps/backend`:

```sh
pnpm exec tsx src/scripts/anydoc-e2e-environment.ts preflight
pnpm exec tsx src/scripts/anydoc-e2e-environment.ts prepare
```

`prepare` creates and migrates a dedicated database and updates only this
worktree's private env files. State lives in ignored
`output/playwright/anydoc/environment.private.json`. It refuses duplicate
preparation. The DB login needs CREATE DATABASE permission. Preflight only
checks DB, Redis and a read-only S3 bucket HEAD; it does not prove write/CORS,
OCR service availability or embedding route readiness.

Start API and worker separately from `apps/backend`:

```sh
pnpm run dev:api
pnpm run dev:worker
```

Start the web server from `apps/web`:

```sh
pnpm exec next dev --port 3100
```

If native file watching fails with `EMFILE` even with a sufficient process file
limit, use `WATCHPACK_POLLING=true` with the same Next command. This changes only
source-file watching, not the application or services under test.

The root `dev:fast` command does not run the worker and is insufficient here.

## Browser acceptance

Use Playwright CLI with a distinct session and the new web URL. Capture fresh
snapshots before selecting controls; retain screenshots and trace under
`output/playwright/anydoc/` (ignored). Create a dedicated test account and
workspace through ordinary authentication; do not bypass authorization.

1. Upload a DOCX and a text PDF with distinct unique phrases and a small table
   containing known numbers through Sources → Add source → File. Record whether the UI chooses multipart API upload or upload-intent/object PUT/upload-complete, and verify that actual path succeeds. Small fixtures currently use multipart API upload; do not claim browser S3 CORS was exercised in that case.
2. Poll `/v1/workspaces/:workspaceId/sources/:id/status` until indexing succeeds.
   Open each source in the UI. Assert phrase, order, numbers and a correct text PDF total page count of 2, document-level citations and no
   invented page references. Save the parser version and actual execution backend metadata.
3. Ask the chat to search the uploaded source for its unique phrase. Verify an
   actual source-search tool result and citation to that source; source listing
   or a model answer without retrieval is insufficient evidence.
4. Upload an image-only PDF with a known phrase. Observe the actual OCR backend
   task ID and pending state, then poll/resume to completed and indexed. Stop
   only the dedicated worker after pending and restart it to test persisted
   recovery. Confirm resume does not resubmit OCR or invoke AnyDoc again.
5. Upload a corrupt PDF. Assert a clear failure and absence of an OCR submission.
   With OCR explicitly disabled, verify a scanned PDF fails with the configured
   actionable error. Restore the chosen OCR policy before further cases.
6. Check the real API logs for unexpected fallback, duplicate billing or
   unhandled errors. Capture timings and failures without credentials.

No standalone sources-search HTTP endpoint currently exists; use the chat
retrieval tool for the complete browser journey. An explicit service-level
retrieval check can supplement it but must be labeled separately.

## Cleanup and reporting

Delete test source records using the UI/API before dropping the database. The current source-delete API leaves S3 objects, so use the runner cleanup with `E2E_DELETE_SOURCE_OBJECTS=true` to also delete only the explicitly selected source prefixes (bounded to five objects per source). This storage step uses the unchanged configured S3 service. Stop only the dedicated API/worker/web
processes and remove their queue jobs. Then, from `apps/backend`:

```sh
pnpm exec tsx src/scripts/anydoc-e2e-environment.ts cleanup
```

Cleanup refuses unexpected database names and does not force-close sessions.
Report each case as passed, failed or blocked, with artifact paths. Record actual
OCR and embedding providers. Missing service access must be resolved explicitly;
do not change the provider or replace the live run with mocks without reporting
the difference and its verification impact.

## Repeatable HTTP assertions

After the UI upload, set `E2E_EMAIL`, `E2E_PASSWORD`, `E2E_WORKSPACE_ID`,
`E2E_DOCX_SOURCE_ID`, `E2E_TEXT_SOURCE_ID`, `E2E_OCR_SOURCE_ID`, and
`E2E_OCR_TASK_ID` in the process environment. Do not commit these values.
From `apps/backend` run:

```sh
pnpm exec tsx src/scripts/anydoc-e2e-assert.ts pending
pnpm exec tsx src/scripts/anydoc-e2e-assert.ts assert
```

The pending mode verifies the same durable OCR task after a worker restart;
assert mode additionally requires OCR content and indexing completion. Both
modes independently assert DOCX content/billing and text PDF content/page count.
Reports contain only selected non-secret fields. Use `cleanup` mode to delete
the selected test sources via the normal API before dropping the DB. Include additional negative-case source IDs in `E2E_EXTRA_SOURCE_IDS` (comma-separated) so all uploaded objects are removed.
Browser chat retrieval and citations still require the separate UI assertions.
