# Report-local structure

The generator owns this JSON contract; it is not a general document schema. `schemaVersion` is exactly 1. All objects reject unknown keys. Public text is literal text, not HTML or Markdown. Runtime citation tokens, controls and unsafe URLs are rejected. Source input is limited to 2 MiB, 20 sections and 100 total blocks; these are parser bounds, not a promised source-coverage or document-length SLA.

Required root fields: `schemaVersion`, `title`, `language` (`zh-CN` or `en-US`), `template` (`briefing`, `comparison`, `decision`), `summary`, `sections`, `sources`. Optional `audience` is descriptive text. Summary is 1–10 statements. A statement is `{ "text": "…", "kind": "fact|analysis|recommendation", "citations": ["S1"] }`; facts must have citations. Analysis and recommendations are labeled in each exported format; cite the supporting evidence when available. The `citations` array is the only entry point for rendered report citation numbers. Do not type `[S1]` or a list such as `[S1, S2]` into summary, paragraph, bullet or table-cell `text`; validation rejects these instead of deleting or rewriting them. Plain `S1`, ordinary numeric brackets and literal HTTP(S) URL path/query brackets remain ordinary text.

Sections have unique lowercase `id`, `heading`, and `blocks`. Supported blocks:

- Paragraph: `{ "type": "paragraph", "text": "…", "kind": "fact", "citations": ["S1"] }`.
- Bullets: `{ "type": "bullets", "items": [statement] }`.
- Table: `{ "type": "table", "columns": ["Product", "Capability"], "rows": [[cell, cell]] }`. Every row matches the column count; 1–10 columns and 1–100 rows. A cell is `{ "text": "…", "status": "value|unknown|conflict|not_applicable", "citations": [] }`. Value and conflict require citations. Unknown/not_applicable may have no citation and retain their explicit rendered status. Conflict should cite all conflicting observed sources, describe the discrepancy, and avoid resolving it without evidence.

Sources have unique IDs `S1`, `S2`, etc. Each has `display` with required `title`, optional human-readable `locator` and true `http(s)` URL; links with embedded credentials are rejected. Optional `provenance` contains only observed string fields `sourceId`, `documentId`, `chunkId`, `fileId`, `scope`, `revision`, `locator`. Provenance is never used to manufacture public source links and never enters public export rendering. See evidence-and-export.md for the evidence boundary.

## Templates

- **Briefing**: scope/question, key findings, limitations and next steps.
- **Comparison**: entities and dimensions, evidence-backed comparison table, differences and unknown/conflicting information, implications.
- **Decision**: decision question and criteria, evaluated options, recommendation with rationale, assumptions, risks and unresolved information.

These are writing structures, not hidden facts or automatic section injection. Keep one editable input and the same facts/numbers/source IDs in every output. The fictional-product fixture in `tests/fixtures/` is an example of the contract and an explicit test input, not researched market evidence.
