# Report-local structure

The generator owns this JSON contract; it is not a general document schema. `schemaVersion` is exactly 1. All objects reject unknown keys. Public text is literal text, not HTML or Markdown. Runtime citation tokens, controls and unsafe URLs are rejected. Source input is limited to 2 MiB, 20 sections and 100 total blocks; these are parser bounds, not a promised source-coverage or document-length SLA.

Required root fields: `schemaVersion`, `title`, `language` (`zh-CN` or `en-US`), `template` (`briefing`, `comparison`, `decision`), `summary`, `sections`, `sources`. Optional `audience` is descriptive text. Optional `presentation` is the bounded layout contract described below. Summary is 1–10 statements. A statement is `{ "text": "…", "kind": "fact|analysis|recommendation", "citations": ["S1"] }`; facts must have citations. Analysis and recommendations are labeled in each exported format; cite the supporting evidence when available. The renderer adds that label, so statement `text` must not start with it (`分析：`, `建议：`, `Analysis:`, `[Recommendation]` and similar bracketed or colon/dash forms); validation rejects such text instead of stripping it. The `citations` array is the only entry point for rendered report citation numbers. Do not type `[S1]` or a list such as `[S1, S2]` into summary, paragraph, bullet or table-cell `text`; validation rejects these instead of deleting or rewriting them. Plain `S1`, ordinary numeric brackets and literal HTTP(S) URL path/query brackets remain ordinary text.

Sections have unique lowercase `id`, `heading`, and `blocks`. Supported blocks:

- Paragraph: `{ "type": "paragraph", "text": "…", "kind": "fact", "citations": ["S1"] }`.
- Bullets: `{ "type": "bullets", "items": [statement] }`.
- Table: `{ "type": "table", "columns": ["Product", "Capability"], "rows": [[cell, cell]] }`. Every row matches the column count; 1–10 columns and 1–100 rows. A cell is `{ "text": "…", "status": "value|unknown|conflict|not_applicable", "citations": [] }`. Value and conflict require citations. Unknown/not_applicable may have no citation and retain their explicit rendered status. Conflict should cite all conflicting observed sources, describe the discrepancy, and avoid resolving it without evidence.

Sources have unique IDs `S1`, `S2`, etc. Each has `display` with required `title`, optional human-readable `locator` and true `http(s)` URL; links with embedded credentials are rejected. Optional `provenance` is one of the resolvable shapes `kind: chunk | file | external` described in evidence-and-export.md, copied verbatim from `/files` footnotes; objects without `kind` are accepted as legacy free-form strings for existing reports. Provenance is never used to manufacture public source links and never enters public export rendering; HTML citation markers only link to the sources section within the document. See evidence-and-export.md for the evidence boundary.

## Templates

- **Briefing**: scope/question, key findings, limitations and next steps.
- **Comparison**: entities and dimensions, evidence-backed comparison table, differences and unknown/conflicting information, implications.
- **Decision**: decision question and criteria, evaluated options, recommendation with rationale, assumptions, risks and unresolved information.

These are writing structures, not hidden facts or automatic section injection. Keep one editable input and the same facts/numbers/source IDs in every output. The fictional-product fixture in `tests/fixtures/` is an example of the contract and an explicit test input, not researched market evidence.

## Persistent presentation

New report sources should include an explicit presentation choice, for example:

```json
"presentation": {
  "mobileDensity": "compact",
  "tableOfContents": true,
  "pageNumbers": true,
  "citationLayout": "source-notes"
}
```

Each field is optional. `mobileDensity` is `standard` (default) or `compact`; compact changes only the predefined HTML layout at widths up to 600px. It does not shrink Office text or margins. `tableOfContents` is a strict boolean (default false), generating a static list of actual sections after the summary in all formats. HTML and Word use internal section links; no guessed contents page numbers are generated. `pageNumbers` is a strict boolean (default false), enabling actual PAGE / NUMPAGES footer fields in Word and its derived PDF. Continuous HTML and Markdown do not invent physical page numbers. `citationLayout` is `inline` (default) or `source-notes`: the latter puts ordered citations in an explicitly labeled `来源: [S1]` / `Sources: [S1]` note associated with each statement or table cell, including in Markdown. Uncited analysis or unknown cells do not gain empty notes.

No raw CSS, font names, URLs, arbitrary dimensions, unrecognized keys, null values or integer substitutes for booleans are accepted. Missing presentation or fields resolve to the original defaults without mutating or injecting fields into the editing source. Reading a legacy source remains supported; its former manual HTML edits cannot be recovered from an absent source setting. For revisions retain recovered presentation fields, changing only the options requested by the user. The same semantic content, section order, numbers and source IDs remain required in every format. Layout checks and the existing 12,000px HTML budget remain mandatory; a selected style never permits deleting necessary content or increasing the limit.
