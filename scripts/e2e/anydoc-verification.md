# AnyDoc verification — 2026-09-08

## Live environment and scope

Executed from the dedicated `codex/anydoc-inprocess` worktree using API 3101,
Web 3100, a new migrated PostgreSQL database, and the independent
`sourceweft-anydoc-e2e` queue. Existing checkout services on 3000/3001 were not
changed. A new test account signed up through the normal browser UI.

Real PostgreSQL, Redis, S3 bucket access, uploads, worker processing, embeddings,
and chat were used. The existing explicitly selected model gateway configuration
was copied unchanged; the providers/data sources were not substituted. The parser
policy was AnyDoc 0.2.4, explicitly enabled PDF2Markdown OCR, and parser version
`v3-anydoc-0.2.4`. Observed model calls used DeepInfra `BAAI/bge-m3` embeddings, DeepInfra `Qwen/Qwen3-Reranker-4B` reranking, and DeepSeek `deepseek-v4-flash` chat through the existing custom global configuration. No OCR or retrieval responses were mocked.

Small test fixtures used the UI's multipart API upload path. These runs verify
server-side S3 persistence, but do **not** verify browser presigned-PUT CORS.

## Results

| Scenario                              | Result                                               | Evidence                                                                                                             |
| ------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| DOCX upload → AnyDoc → indexing       | Passed after fixing a discovered billing-count bug   | UI Retry created a new revision; API reports indexed, 1 billing unit, Chinese text and Revenue 1234.56               |
| Two-page text PDF → AnyDoc → indexing | Passed                                               | API reports indexed, total page count 2, both alpha 1234 and beta 5678                                               |
| Text PDF citations                    | Passed at document/chunk level                       | UI citation opens one chunk containing both page headings; no invented physical page locator                         |
| Real chat source retrieval            | Passed                                               | Two Search Sources calls; answer gives Revenue 1234.56, alpha 1234 and beta 5678 with source citation buttons        |
| Scanned PDF → real OCR pending        | Passed                                               | Image-only PDF with readable phrase and amount submitted to PDF2Markdown; actual provider task persisted             |
| Worker stop/restart during pending    | Passed                                               | Same task ID after restart, increasing poll attempt, resolved backend PDF2Markdown and entry engine AnyDoc preserved |
| Scanned PDF OCR content → indexing    | Blocked by external provider; local timeout verified | Source failed with PROVIDER_PARSE_TIMEOUT (504); raw provider status remained pending                                |
| Malformed PDF through UI              | Passed negative case                                 | Local malformed document error; no OCR task ID                                                                       |
| New scanned PDF with OCR disabled     | Passed negative case                                 | Explicit DOCUMENT_PARSE_OCR_ENABLED is false error; no OCR task ID                                                   |

The original DOCX attempt exposed `estimated_pages=0`, rejected during the source
indexing update. The implementation was fixed to preserve a one-unit document
billing count separately from physical page locations. Retrying through the UI
then indexed successfully; no database field was manually patched.

The OCR fixture was generated as pixels only and visually checked with Poppler.
It contains `cobalt lantern orchard` and `4321.75 USD`. The first submission
attempt returned `fetch failed`; a subsequent configured job retry yielded a
real pending task. The first request's remote acceptance is unknown, so this run
does not prove exactly-once submission across an ambiguous transport failure.
Restart/resume after a known persisted task does prove reuse of that task.

## Reproduction and artifacts

See [anydoc.md](anydoc.md). The repeatable authenticated API assertion runner is
`apps/backend/src/scripts/anydoc-e2e-assert.ts`. Its pending mode passed all three
source checks at 05:46 UTC, including DOCX billing, text PDF totals and durable
OCR identity. Full assert mode additionally requires the actual OCR text and
indexed status and is a separate acceptance condition.

Local, ignored artifacts under `output/playwright/anydoc/`:

- `api-pending-assertions.json`: selected non-secret HTTP results.
- `retrieval-answer.png`: actual chat tools, answer and citation buttons.
- `text-pdf-citation.png`: citation opens the source chunk containing both headings.
- `ocr-readable.pdf`, `ocr-readable-render.png`: actual image-only OCR input and visual QA.
- API/worker/web logs and browser traces are private debugging artifacts and must
  not be committed or published without review.

Startup required building the workspace market-contracts and UI outputs. Next
initially cached missing-output errors; the existing `clean:web-cache` command
resolved those after the UI build. Native file watching hit EMFILE, so the same
Next development server used `WATCHPACK_POLLING=true`; application behavior and
backends were unchanged.

## Final OCR outcome

The readable scanned PDF source was created at 05:40:55 UTC and reached the
local timeout at 05:52:39 UTC (11 minutes 44 seconds, including deliberate
worker stop/restarts). The 40th poll exceeded the configured bound; the persisted
last pending attempt is 39. Source status is `failed`, error code
`PROVIDER_PARSE_TIMEOUT`, HTTP classification 504. A direct provider status read
returned top-level `status: "pending"`, `page_count: 1`, and unchanged
`created_at` / `updated_at` of 05:40:47.274 UTC. This is an actual pending remote
task, not a response-envelope or status-enum mismatch.

The full HTTP `assert` mode was executed and failed specifically on OCR source
status (`failed` versus expected `indexed`); see local
`api-full-assertion-failure.txt`. OCR text accuracy and final OCR indexing remain
unverified. No provider replacement was attempted. The known remote task may
remain pending after local cleanup; no supported task-cancel interface was used.

## Automated and container checks

The coordinating agent verified:

- Native parser package: 39/39 tests passed.
- Final sources/config suite: 193/193 tests passed.
- Backend typecheck and formal build passed.
- Cached project images with Node 22.23.2 on Linux ARM64 and AMD64: real AnyDoc
  DOCX parsing and typed needsOcr behavior passed.
- ARM64 container with networking disabled: pdfjs total-page counting returned 2.

The complete Dockerfile rebuild was not verified: its base-image pull made no
progress and was terminated. Cached-container checks do not constitute a fresh
Docker image rebuild.

## Cleanup

All five test source records were deleted through the authenticated API. Since
the existing deletion API does not remove S3 objects, cleanup then explicitly
removed only each of the five known source prefixes in the test workspace,
using the existing bounded storage deletion function. The dedicated API,
worker, web and browser were stopped, both dedicated queues removed without
force, and the isolated database dropped. The temporary OCR-disabled setting
was restored. Original checkout services on ports 3000/3001 remain intact.

Screenshots, selected terminal-state JSON, and private logs/browser traces remain
in the ignored artifact directory. Credentials and account/database state are
not included in this report.
