---
name: report
description: Create and revise source-grounded research briefs, comparison reports and decision recommendations with matching HTML, Markdown and requested Word/PDF exports. Use for research and work deliverables based on selected material.
---

# Research reports

Use the current root Agent and existing sandbox/publish tools. Do not start another Agent or invent a report service. Read [report-structure.md](references/report-structure.md) and [evidence-and-export.md](references/evidence-and-export.md); for revisions also read [revision.md](references/revision.md).

## Scope and preparation

1. Establish the question, audience and selected source scope. Read actual authorized sources with the current source tools; `/files` is working memory, not independent evidence. Observe/retain useful source footnotes. Do not invent provenance, citations, prices, coverage or confidence.
2. Respect `<skill_runtime_config name="report">`: template (briefing/comparison/decision), language (auto/zh-CN/en-US), length (concise/standard), audience and formats. Infer auto language from the request; the JSON must resolve to zh-CN or en-US. Concise normally has 2–4 sections, standard 4–6. Keep the actual page within the existing 12,000px QA limit; never truncate or bypass QA to force a pass.
3. Write `report.source.json` as a persistent Workfile, then use `prepare_sandbox_workspace` to stage it under the active sandbox workspace. `/files` and `/kb` are logical paths, not command paths. Skill scripts are already staged under `/skills/report` (or the runtime-provided physical skill root); do not copy or rewrite them. Report does not require the separate HTML Skill to be enabled.
4. Use the strict report-local JSON documented in `references/report-structure.md`. Facts require source references, analysis/recommendations are visibly labeled, and unknown/conflicting table cells are explicit. Only `sources[].display` reaches public formats; `provenance` stays private. Structural validation does not authenticate evidence or establish factual support.

## Generate once, derive the requested formats

Choose a fresh generation directory for each attempt/version; existing directories are rejected. The same validated content generates every format. Default `html,md`; add DOCX/PDF only when requested. PDF conversion uses a temporary DOCX when DOCX was not requested; it does not silently add a Word deliverable.

```bash
python3 /skills/report/scripts/generate_report.py --source /workspace/report.source.json --output-dir /workspace/report-v1 --formats html,md
node /skills/report/scripts/build-html.cjs /workspace/report-v1/draft.html /workspace/report-v1/report.html
python3 /skills/report/scripts/verify_report.py --source /workspace/report-v1/report.source.json --output-dir /workspace/report-v1 --formats html,md
node /skills/report/scripts/qa-html.cjs /workspace/report-v1/report.html /workspace/report-v1/qa
```

Use actual runtime paths and exactly the selected format list in generation and verification. DOCX uses the provisioned python-docx and Noto fonts; PDF uses the provisioned LibreOffice and Poppler. HTML uses the configured SOURCEWEFT_HTML_RUNTIME and SOURCEWEFT_HTML_FONTS. Missing dependency, font, model, conversion failure, invalid input, verification failure or height overflow blocks delivery. Report the actual failure; do not install packages, change converter/provider, omit a requested format or reuse older files.

Call existing `review_html_visuals` with all three final HTML QA screenshots, checking report legibility, table overflow, sources and tail content. For DOCX/PDF, render and inspect every resulting PDF page with the provisioned LibreOffice/`pdftoppm` path. If DOCX is requested without PDF, a temporary PDF may be used only for visual QA and is not a deliverable. Fix concrete issues in the input/layout and regenerate in a new directory, then rerun verification and visual review. `generated_pending_qa` is not completion; `visualReview: not_run` and `evidenceAuthenticated: false` remain honest limitations of structural checks.

## Publish

Publish only after every selected format and final QA has passed. Use `artifactType=html`, primary `report.html`, and `expectedContentDigest` from final HTML QA. Attach the actually generated `report.md`, `report.docx`, `report.pdf` as role=asset/access=artifact, only when selected. Always attach `report.source.json` as role=source/access=private with application/json. Do not publish `draft.html`, QA logs, private provenance or intermediate conversion files as public assets. Use the existing artifact publisher and version receipts; do not claim a finished deliverable before the committed artifact/version is returned.

For an edit, first restore the exact version's private input using the existing named-file prepare selector as described in revision.md, capture its versionNo and recheck affected evidence. Publish with republishArtifactId and that expectedVersionNo. Never substitute the latest version or reverse-engineer private input from public HTML.
