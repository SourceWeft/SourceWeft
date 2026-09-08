# AnyDoc document parsing

## Engine and format ownership

`@firecrawl/anydoc` 0.2.4 is the sole content extraction engine for every document format it supports. There is no legacy Office/PDF provider selector, HTTP gateway, hosted AnyDoc fallback, or upstream fork. The parser package owns local conversion, byte/type validation, native error classification and normalized output. The backend owns OCR, tenant/billing context, queue state and diagnostics. Plain text, JSON, SRT, audio, images and web pages retain their dedicated paths because AnyDoc does not support those inputs.

The browser-safe `@sourceweft/builtin-document-parsers/formats` entry exposes the shared extension/MIME capability catalog. Upload classification and parser registration consume this catalog. It mirrors the release's complete native extension list:

| Native format          | Supported extensions   |
| ---------------------- | ---------------------- |
| doc                    | doc                    |
| docx                   | docx, docm             |
| ppt                    | ppt, pps, pot          |
| pptx                   | pptx, pptm, ppsx, ppsm |
| xlsx                   | xls, xlsx, xlsm, xlsb  |
| odt / ods / odp        | odt, ods, odp          |
| rtf / epub / csv / pdf | rtf, epub, csv, pdf    |

Macro and slideshow MIME variants are explicit catalog entries. Existing CSV, PDF, Word and PowerPoint MIME aliases are retained. Byte detection must agree with the declared format family; an XLS binary workbook intentionally resolves to the native `xlsx` family. A declared native format is supplied for signature-less CSV and containers that need a format hint. Native encrypted/malformed errors still fail; they never select a different engine. Native loading is deferred until conversion, so importing the catalog or another parser does not load its binary.

## OCR and image configuration

- `DOCUMENT_PARSE_OCR_ENABLED=false` by default; credentials do not enable OCR.
- `DOCUMENT_PARSE_OCR_PROVIDER=pdf2markdown` selects the explicitly supported OCR backend.
- `DOCUMENT_PARSE_IMAGE_STRATEGY=vision|ocr` selects one image policy. Vision errors do not automatically call OCR. Image OCR requires OCR activation.
- AnyDoc always uses `ocr: "reject"`, including when ambient Firecrawl credentials exist.
- Only native `needsOcr` enters the declared OCR branch. Scanned/mixed PDFs send the whole original document to the configured backend; no partial local extraction is accepted.
- Encrypted, malformed, unsupported, resource-limit, metadata, chunking and remote errors fail without replacement providers.

Old `DOCUMENT_PARSE_PROVIDER` and `DOCUMENT_PARSE_STRATEGY` selectors are retired. New ingestion uses `v4-anydoc-unified-0.2.4`. Existing indexed revisions are not automatically reprocessed. Rollback requires reverting the deployment; there is no per-file legacy parser fallback. Image deployments previously relying on automatic vision-to-OCR switching must choose an explicit policy.

## Asynchronous state

OCR pending tokens retain actual backend ID `pdf2markdown`. Resume dispatches directly to that backend without rerunning AnyDoc. Entry-engine and actual-backend diagnostics remain distinct. Once the OCR task is persisted, retried source jobs resume that task. An external submission accepted before its response/task ID is durably recorded cannot be guaranteed exactly once without provider idempotency support; never describe the whole path as exactly once.

## Physical pages and billing units

AnyDoc 0.2.4 text-PDF Markdown does not contain reliable page markers. Do not infer pages from headings or construct a fake page one. Results have `pages: []` and `pageLocationAvailable: false`; physical page-level citations are unavailable even though document-level retrieval works.

The existing `pdfjs-dist` dependency reads only PDF `numPages`, recorded as `pageCountSource: "pdfjs"`. It never extracts or replaces body text. Metadata inspection failure fails parsing rather than estimating a count.

All file parsing is billed centrally using the existing `credits-core` ingestion rule. A verified physical PDF/image page count takes precedence. Without physical pages, the source service estimates tokens with `max(1, ceil(content.length / 4))` and charges `max(1, ceil(tokens / 1000))` standard pages. This is the existing UTF-16 string-length estimate; it does not introduce a Chinese/English word segmentation rule. Empty content fails ingestion.

AnyDoc does not emit per-document, CSV-record, spreadsheet-row or EPUB-chapter billing overrides. Office/CSV/EPUB outputs without physical pages use the same text-based charge as other unpaginated files. The previous record/chapter/document-one compatibility pass was removed because it incorrectly bypassed the existing rule. No `d3-dsv`, `epub2` or `html-to-text` accounting dependency remains. The central parsing/indexing and real ledger tests verify token boundaries, physical-page precedence and idempotent charging.

## Verification

Native tests exercise all 21 official extensions, including binary DOC/PPT/XLS/XLSB, OpenDocument formats, content-type-correct macro/slideshow variants, Chinese text, table numbers, text/scanned/mixed PDFs and errors. Upstream real fixtures are pinned to the v0.2.4 release with MIT license/provenance in `tests/fixtures/anydoc/upstream-v0.2.4`; synthetic fixtures and transformations are documented alongside them. These samples verify native compatibility, not a representative document-quality benchmark.

Native content regressions cover CSV header-only/empty/multiline fields and single-chapter EPUB packages without a legacy metadata reader. Every supported format asserts that the parser emits no billing override. Backend tests enforce central page/text charging. Other tests enforce no hosted upload, narrow OCR routing, shared MIME registration and no eager native loading.

Real application E2E verification must use an isolated database/queue/ports: authenticate, upload through supported UI, wait for worker parsing and indexing, inspect actual engine/format metadata, and retrieve through chat. Remote OCR and model calls must be distinguished from mocks, and external service failures reported rather than replaced.

## Deferred

Structure-aware chunking, embedded Office image OCR and full document blocks/assets persistence remain separate changes. Page-level PDF provenance needs an upstream structured-output capability or an explicitly designed enhancement; Markdown headings are insufficient.
