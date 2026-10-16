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
4. New reports include explicit `presentation` settings described in `report-structure.md`: bounded mobile density, optional static contents, Office page numbers and inline or labeled source-note citations. Choose these for the requested deliverable; record them in the source before generation. Existing report revisions preserve the recovered choices. Do not patch generated CSS or copy a former HTML layout by hand: make a supported source-level setting change and regenerate all promised formats. Presentation does not increase the 12,000px budget or permit reducing Office fonts/margins to force a pass.
5. Use the strict report-local JSON documented in `references/report-structure.md`. Put source IDs only in each statement/cell `citations` array; never handwrite `[S1]`-style report markers in summary, paragraph, bullet or cell text, because the renderer adds them once. Validation rejects such input rather than silently deleting it. Facts require source references, analysis/recommendations are visibly labeled, and unknown/conflicting table cells are explicit. Only `sources[].display` reaches public formats; `provenance` stays private. Structural validation does not authenticate evidence or establish factual support.

## Execution and verification integrity

Run content verification and HTML QA as separate `execute` calls and retain their full result JSON. Do not pipe either command through `tail`, `head`, `cat`, a JSON parser, or any other command: the last process can hide the check's failure. Do not append a successful command after a failed check or suppress failure with `|| true`. If a generation phase must combine commands, use Bash with `set -euo pipefail` at the beginning; retain the check outputs and inspect their results as well.

A verification or HTML QA JSON result with `passed: false` is a hard stop, even if `execute.exitCode` is zero. Report the actual failing issues and stop that attempt's downstream visual review and publication. Diagnose and correct the source or supported renderer, generate a fresh attempt, and rerun verification and QA before resuming visual checks. A visual review pass cannot override a failed structural, content or height check. In particular, never append `; echo "QA_EXIT=$?"`, `; true`, or another successful command to a check, and never pipe the result through another process: those patterns can replace the check's actual exit code with a success.

A sandbox operation marked `succeeded` means the execution request completed; it does not mean the command or report passed. For every required step, inspect the returned tool `exitCode`. Verification requires both `exitCode=0` and its returned JSON `passed=true`; HTML QA independently requires both `exitCode=0` and `qa.json`/its returned JSON `passed=true`. A pipeline's exit code, a truncated log, an older attempt's success, or `generated_pending_qa` is not proof. If the result JSON is missing or truncated, read the saved check result in a separate operation before proceeding. Structural checks still do not replace actual evidence and visual review.

Verify against the original prepared input path used for generation; do not point `--source` at the output copy of `report.source.json` and compare it with itself. Bind each result to the current attempt's input, output paths and final file digests. Re-run verification and QA after any content or layout change, and use only that attempt's screenshots and receipts. A final attempt cannot inherit an earlier version's passed status. Preserve failed attempts in their own directories.

If a long report exceeds the HTML height limit or fails PDF checks, record the actual failure and diagnose the input/layout. Do not delete necessary facts, source coverage, limitations, conflicting values or references merely to obtain `passed=true`. For any content revision, record what sections, claims, table rows and citations were added, removed or corrected, why the change serves the user's scope, and which underlying evidence was rechecked. Compare the revised report against the original scope before delivery. If complete content cannot satisfy the current bounds, report that blocker rather than silently reducing the promised deliverable.

## Generate once, derive the requested formats

Choose a fresh generation directory for each attempt/version; existing directories are rejected. The same validated content generates every format. Default `html,md`; add DOCX/PDF only when requested. PDF conversion uses a temporary DOCX when DOCX was not requested; it does not silently add a Word deliverable.

```bash
python3 /skills/report/scripts/generate_report.py --source /workspace/report.source.json --output-dir /workspace/report-v1 --formats html,md
node /skills/report/scripts/build-html.cjs /workspace/report-v1/draft.html /workspace/report-v1/report.html
python3 /skills/report/scripts/verify_report.py --source /workspace/report.source.json --output-dir /workspace/report-v1 --formats html,md
node /skills/report/scripts/qa-html.cjs /workspace/report-v1/report.html /workspace/report-v1/qa
```

The commands above are sequential phases, not a shell block whose last exit code certifies every phase. Execute verification and QA separately under the integrity rules above. Use actual runtime paths and exactly the selected format list in generation and verification. DOCX uses the provisioned python-docx and Noto fonts; PDF uses the provisioned LibreOffice and Poppler. HTML uses the configured SOURCEWEFT_HTML_RUNTIME and SOURCEWEFT_HTML_FONTS. Missing dependency, font, model, conversion failure, invalid input, verification failure or height overflow blocks delivery. Report the actual failure; do not install packages, change converter/provider, omit a requested format or reuse older files.

Call existing `review_html_visuals` with all three final HTML QA screenshots, checking report legibility, table overflow, sources and tail content. For DOCX/PDF, render and inspect every resulting PDF page with the provisioned LibreOffice/`pdftoppm` path. If DOCX is requested without PDF, a temporary PDF may be used only for visual QA and is not a deliverable. Fix concrete issues in the input/layout and regenerate in a new directory, then rerun verification and visual review. `generated_pending_qa` is not completion; `visualReview: not_run` and `evidenceAuthenticated: false` remain honest limitations of structural checks.

## Publish

Publish only after every selected format and final QA has passed. Use `artifactType=html`, primary `report.html`, and `expectedContentDigest` from final HTML QA. Attach the actually generated `report.md`, `report.docx`, `report.pdf` as role=asset/access=artifact, only when selected. Always attach `report.source.json` as role=source/access=private with application/json. Do not publish `draft.html`, QA logs, private provenance or intermediate conversion files as public assets. Use the existing artifact publisher and version receipts; do not claim a finished deliverable before the committed artifact/version is returned.

For an edit, first restore the exact version's private input using the existing named-file prepare selector as described in revision.md, capture its versionNo and recheck affected evidence. Publish with republishArtifactId and that expectedVersionNo. Never substitute the latest version or reverse-engineer private input from public HTML.
