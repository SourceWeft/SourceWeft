# Unified AnyDoc verification — 2026-09-08

## Outcome

The unified implementation passed **15 live HTTP acceptance cases** after real
browser uploads: 14 native document-format inputs indexed through AnyDoc, and
one scanned PDF failed explicitly with OCR disabled. All 15 cases passed again
after an EPUB reparse performed by the built production worker. No parser,
embedding, retrieval or storage responses were mocked.

The source body parser is AnyDoc 0.2.4 with version
`v4-anydoc-unified-0.2.4`. The previous local-provider/strategy overrides were
removed. The pre-existing custom model gateway configuration was retained:
observed calls used DeepInfra `BAAI/bge-m3` embeddings,
`Qwen/Qwen3-Reranker-4B` reranking, and DeepSeek `deepseek-v4-flash` chat.

## Browser upload and API acceptance

All files were selected together through the normal Add source dialog. These
small fixtures used multipart API upload and real server-side S3 persistence;
browser presigned-PUT CORS was not exercised. The manifest-driven HTTP runner
independently checked source status, actual AnyDoc engine/route metadata,
non-empty indexed chunks, fixture words/numbers and accounting expectations.

| Input files                                | Actual detected format | Result           | Checked values / accounting                                          |
| ------------------------------------------ | ---------------------- | ---------------- | -------------------------------------------------------------------- |
| sheet.xlsx, sheet.xls, handmade-sheet.xlsb | xlsx                   | Indexed          | Currency $1,234.50; 15.5% or 65.0%; 1 document unit each             |
| text.rtf, text.odt, text.doc               | rtf / odt / doc        | Indexed          | Fixture Document; list continuation in RTF/ODT; 1 document unit each |
| pres.ppt, pres.odp                         | ppt / odp              | Indexed          | Deck Title Slide, Numbers Slide, 42; 1 document unit each            |
| sheet.ods                                  | ods                    | Indexed          | $1,234.50, 15.5%, 9,876,543; 1 document unit                         |
| sample.docx                                | docx                   | Indexed          | Chinese text and Revenue 1234.56; 1 document unit                    |
| sample.pptx                                | pptx                   | Indexed          | SourceWeft slide 42; 1 document unit                                 |
| sample.epub                                | epub                   | Indexed          | SourceWeft chapter, 9876; 1 chapter unit                             |
| sample.csv                                 | csv                    | Indexed          | Chinese text, 1234.56, SourceWeft, 42; 2 record units                |
| text.pdf                                   | pdf                    | Indexed          | alpha 1234, beta 5678; true total page count 2                       |
| scan.pdf                                   | No completed parse     | Expected failure | DOCUMENT_PARSE_OCR_ENABLED is false; no provider task                |

XLS and XLSB use the native engine's reported `xlsx` format; the report does not
pretend their input extensions are independently reported detection values.
This browser matrix covers 14 concrete input extensions; catalog aliases and
malformed-input boundaries have separate automated coverage.

## Real retrieval and citations

With the uploaded files selected and web access disabled, the normal chat made
five actual Search Sources calls. Its visible answer correctly reported:

- XLSX Currency **$1,234.50** and Percent **15.5%**, citing sheet.xlsx.
- RTF heading **Fixture Document** and **Fourth, continuing the count**, citing text.rtf.
- DOCX Revenue **1234.56**, citing sample.docx.
- PDF **alpha 1234** and **beta 5678**, citing text.pdf.

Opening the XLSX citation displayed the parsed Values table and Merged Grid
from that uploaded source. This verifies citation navigation, not just matching
answer text. The visible answer arrived after about 4 minutes 38 seconds, mostly spent in the configured model's reasoning phase; the model was not replaced to shorten the test.

**Chat terminal-state discrepancy:** the UI also displayed “Generation stopped by the user.” The trace contains no Stop click or cancel request. At 14:53:24 local time, the worker logged `CHAT_RUN_OWNERSHIP_LOST`, followed by “Chat worker stopped after durable terminal commit” with status `completed`. The test worker was stopped later, around 14:54:40, so that deliberate process stop did not cause the earlier UI notice. Retrieved content and citation navigation passed, but normal chat completion is **not confirmed** because the UI and worker terminal evidence disagree. This discrepancy remains unresolved; correct visible answer text is not treated as proof of a clean chat terminal state.

## Built production worker

After the answer and citations were visible and the worker had logged its durable terminal state (with the discrepancy noted above), the dedicated development worker was stopped and
`node dist/worker.js` started with the same database, queue and provider
configuration. Successful-source UI menus expose Re-index, which does not
reparse files, so the supplementary trigger used the real authenticated
`POST /sources/:id/reparse` API with `forceRefresh: true`.

The runner confirmed a new indexed EPUB revision. The source had two revisions
afterward, and the production worker log records completion of its second
source-parse job. The EPUB body and one-chapter billing count passed again;
all 15 manifest assertions were rerun with zero failures. This specifically
exercises the built worker's external epub2 dependency and accounting path.
It supplements, rather than replaces, the earlier browser upload coverage.

## Legacy implementation and dependency removal

Read-only source inspection confirmed the old DOCX/PPTX/EPUB/CSV parser files,
legacy PDF provider and PDF classifier were removed. No old Office/PDF loader
factory or parser references remain in production source paths. The remaining
classic text/JSON loader helpers cover formats outside AnyDoc's supported
catalog and are not duplicate Office/PDF parsers.

The coordinating agent verified that `pnpm -r why mammoth officeparser pdf-parse
@langchain/community` produces no dependency-tree entries. epub2 and d3-dsv
remain only for legacy-compatible chapter/record accounting metadata; pdfjs
remains only for physical PDF total-page counting. They do not supply a second
body parsing route.

## Automated checks

The coordinating agent completed **238 automated tests**: 67 parser-package,
170 backend, and 1 web upload-catalog test. Backend formal build and web typecheck
passed. The new manifest-driven E2E helper also passed backend build typecheck.
These checks are separate from the 15 real HTTP cases and their production-worker
rerun; repeated cases are not counted as distinct feature coverage.

## OCR boundary

Before this run, the prior real PDF2Markdown task was queried read-only. Its
raw status remained `pending`, with unchanged created/updated timestamps of
05:40:47.274 UTC on 2026-09-08. Accordingly, this round submitted **no new OCR
tasks**. The new scanned-input check verifies strict OCR-disabled behavior;
it does not claim live OCR completion. The historical timeout and known-task
restart/resume evidence remain in [the earlier report](anydoc-verification.md).
The external completion blocker is unchanged.

## Reproduction, artifacts and cleanup

See [the unified runbook](anydoc-unified.md) and
`apps/backend/src/scripts/anydoc-formats-e2e-assert.ts`. The helper accepts a
manifest containing any number of successful/negative cases and an explicit
parser version. Its `reparse` mode targets one known successful fixture before
rerunning the full manifest; cleanup validates source UUIDs and filenames and
bounds object deletion to the selected source prefixes.

Local ignored artifacts under `output/playwright/anydoc-formats/` include:

- `api-assert-results.json`, `api-reparse-results.json`, `api-cleanup-results.json`.
- `retrieval-answer.png`, `xlsx-citation.png`, `final-source-statuses.png`.
- `terminal-state.json`, `prior-ocr-status.json`, `legacy-removal.json`, and `chat-terminal-audit.json`.
- Private browser traces and service logs; these must not be committed unreviewed.

All 15 test source records and their scoped S3 objects were deleted successfully.
The dedicated development/production workers, API, web server and browser were
stopped; both dedicated queues were removed without force and the fresh test
database was dropped. The temporary OCR-disabled flag was restored to its
pre-test value after workers stopped. Original checkout services on 3000/3001
were left unchanged. The initial E2E report and artifacts were retained.
