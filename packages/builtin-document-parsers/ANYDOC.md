# AnyDoc in-process document parsing

## Decision

Use @firecrawl/anydoc 0.2.4 inside the existing document parser capability. Backend orchestration calls the configured OCR provider only when native conversion reports `needsOcr`. No HTTP gateway, hosted AnyDoc fallback, or upstream fork is introduced.

The user approved the design and implementation in an isolated branch/worktree with multiple agents and end-to-end verification.

## Scope and ownership

The parser package owns local conversion, format validation, native error classification and result normalization. The backend owns remote provider selection, tenant/billing context, queue state and diagnostics. Existing PDF2Markdown asynchronous submission/resume remains the OCR implementation. Text, JSON, SRT, audio and web parsers keep their dedicated paths.

Initial AnyDoc formats are the existing DOCX, PPTX, EPUB, CSV and PDF formats covered by real native fixtures. Additional formats require explicit fixture and upload validation work before exposure.

## Routing and configuration

- `DOCUMENT_PARSE_PROVIDER=anydoc` enables the new Office/PDF path explicitly; the deployment default remains `pdf2markdown` during migration.
- `DOCUMENT_PARSE_OCR_ENABLED=false` by default; existing credentials do not enable OCR.
- `DOCUMENT_PARSE_OCR_PROVIDER=pdf2markdown` selects the OCR implementation.
- `DOCUMENT_PARSE_IMAGE_STRATEGY=vision|ocr` selects one image policy. Vision errors do not automatically call OCR. Image OCR requires OCR activation.
- AnyDoc uses `ocr: "reject"` even if ambient Firecrawl credentials are present.
- Only native `needsOcr` enters the declared OCR route. Encrypted, malformed, unsupported, resource-limit, chunking and remote errors fail without replacement providers.
- Existing legacy balanced/cost PDF routing remains selectable, but classification and extraction errors no longer cause catch-all remote fallback.

The AnyDoc path is independent of legacy strategy heuristics. Unknown explicit configuration fails loading. Activation and credentials are separate from global model Provider and BYOK configuration.

## Asynchronous state

OCR `pending` tokens retain the actual backend ID (`pdf2markdown`). Resume dispatches directly to that backend, without rerunning AnyDoc. Persist the requested provider, actual backend and AnyDoc entry-engine diagnostics. Completed results must carry the same diagnostics in document metadata, not only a transient outcome wrapper.

## Page provenance and billing

Native AnyDoc 0.2.4 text-PDF output has no reliable page markers. Never infer PDF pages from Markdown headings or construct a fake first page. Explicit `pages: []` means page locations are unavailable. Record `pageLocationAvailable: false`.

Use the already installed pdfjs-dist solely to read PDF `numPages`, with an explicit page-count source diagnostic, so billing does not treat a multipage PDF as one page. PDF.js does not extract or replace AnyDoc body text. Metadata reading failure is a failure, not an estimated count. Page-level PDF citations remain unavailable on this path, which is why migration is opt-in.

For Office logical billing units, retain `billingPageCount` separately from physical page locations. DOCX/PPTX keep one document unit; CSV/EPUB retain the existing loader record/chapter counts via an explicit metadata-only compatibility pass. This costs a second parse for CSV/EPUB and retains their existing dependencies, but never replaces AnyDoc body text or changes the existing charge units. Compatibility metadata failure fails parsing.

## Migration

Select AnyDoc and `v3-anydoc-0.2.4` together for new ingestion. Existing indexed revisions are not silently reprocessed. Roll back through explicit configuration; do not retry individual failures through legacy loaders. Image deployments previously relying on automatic vision-to-OCR behavior must select the desired image policy explicitly.

## Verification

Use native fixtures for Chinese text, tables/numbers, slides, EPUB, CSV, text/scanned/mixed PDFs and malformed content. Assert local conversion never calls hosted OCR. Verify narrow OCR routing, activation, actual backend tokens, resume metadata and source-level integration. Check strict config parsing and backend/Docker example consistency.

Run real end-to-end verification in an isolated database, queue and API/Web ports: authenticate, upload through the supported UI flow, parse through the worker, inspect content, index and retrieve. Distinguish real remote OCR/embedding calls from unit-test mocks. Store sanitized evidence and report any external service blocker without replacing providers or models.

## Deferred

Structure-aware chunking, embedded Office image OCR, full document blocks/assets persistence, additional document formats, and a default provider switch are separate changes.
