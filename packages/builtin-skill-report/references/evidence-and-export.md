# Evidence and export

Use the existing Agent, source readers, sandbox and artifact publisher. Passing the source schema and rendering checks does not certify that a claim is true.

## Gather real evidence

Read the selected sources through `/kb`, `search_sources` or authorized file readers. For requested web research, use actual web reader results. Uploaded or mentioned sources are not assumed `/files` paths. Establish source coverage before writing conclusions; preserve missing information and disagreements instead of guessing.

When persisting research notes in `/files`, copy current reader `[citation:cN]` markers exactly. Observe the saved content: the backend rewrites recognized markers into footnotes with stable source/document/chunk or file identity/revision/location. Unknown markers become explicit non-citable notices. Resolve these by reading evidence, not by erasing the warning.

Ordinary `/files` reads are persisted working memory, not fresh source evidence. A hand-written Evidence identity, an old footnote or a saved report does not become trusted because it resembles backend output. Re-read underlying sources when needed to substantiate a new claim. Do not register invented citations through another tool.

The current capability citation port does not provide a trusted report evidence snapshot. This workflow relies on real readers and Agent review. Do not describe footnote parsing, JSON validation or a successful export as host authentication of source identities, current authorization or factual accuracy. Check that evidence actually supports each claim, including important numbers, units and comparison conclusions.

## Author one private source

Use `report.source.json` with `schemaVersion: 1`, `title`, `language` (`zh-CN` or `en-US`), `template` (`briefing`, `comparison` or `decision`), `summary`, `sections` and `sources`; `audience` is optional. Follow the generator's strict schema, without adding fields.

A statement has `text`, `kind` (`fact`, `analysis` or `recommendation`) and `citations`. Facts require citations. Summary statements follow the same rules. Each section has a unique `id`, `heading` and `blocks`. Use paragraph, bullets or table blocks, not raw HTML, Markdown fragments or scripts.

Tables use `columns` and rectangular `rows`. A cell has `text`, `status` (`value`, `unknown`, `conflict` or `not_applicable`) and `citations`. Value and conflict cells require supporting sources. Unknown stays unknown; lack of evidence does not establish that a feature is absent or inapplicable. Conflicts should describe the disagreement and cite the competing evidence.

Each source has a unique report-local ID such as `S1`, matching `S` followed by a positive integer, independent of turn-local `c1`. Citations contain these IDs. Sources have `display: { title, locator?, url? }` and optional private `provenance`, which takes one of three resolvable shapes distinguished by `kind`:

- `{ "kind": "chunk", "sourceId", "documentId", "chunkId", "chunkNo"?, "path"? }` — copied verbatim from a `/files` footnote `Source Library: … Evidence: {sourceId, documentId, chunkId, chunkNo, path}`; keep `chunkNo` (0-based, as the host numbers chunks) and `path` only when the footnote shows them.
- `{ "kind": "file", "workspaceId", "threadId", "backendKind", "fileId", "relativePath", "revision", "locator" }` — copied verbatim from a `/files` footnote `File: <relativePath>. Identity: {workspaceId, threadId, backendKind, fileId}. Location: {locator}. Version: sha256:…`; `locator` is the footnote's location object unchanged.
- `{ "kind": "external", "url" }` — the actual HTTP(S) URL that was read.

Copy only the fields listed; the validator rejects unknown keys. Never invent, guess, abbreviate or recombine identities: an id that was not observed in a current footnote or reader result does not belong in provenance. Omit `provenance` when no footnote exists rather than fabricating one. Earlier sources without `kind` (free-form string fields) remain valid for revisions. Provenance stays private in every export; a saved source is an editing record, not authority to access data.

## Separate public references from private provenance

Public display fields contain human-readable titles, actually observed page/section/table locations and actual HTTP(S) URLs. Do not include URL credentials. For internal material without a public URL, keep the title and useful observed locator without manufacturing a SourceWeft link.

Keep internal IDs, file revisions and machine identity in private provenance. Never emit `/kb`, `/files`, workspace/thread/file/chunk IDs, storage coordinates, runtime markers or raw identity JSON into public report text and references. In HTML each rendered `[S1]` marker is an in-document link to the matching entry of the sources section; this is display navigation only, carries no provenance, and `display.url` stays plain text. Inspect all public text fields, including titles, tables and display.locator: omitting the provenance object alone does not sanitize copied confidential text.

Escaping text prevents executable markup; it does not determine whether the text should be disclosed. Review the report's actual source disclosure before publishing.

## Review content before publishing

Review the actual draft against the passages returned by the readers, separately from format verification. Scale review coverage to the report's complexity and consequences; check every decision-critical fact rather than imposing a fixed sample count on every report.

- For each key fact, match its citation to the specific supporting passage, not merely the source title. Check the meaning, numbers, units and table dimension. Being able to locate a citation does not establish that it supports the assertion. Correct wrong-source citations and split sentences whose parts have different support.
- An analysis or recommendation label does not substantiate its factual premises. Support those premises, qualify the claim to the observed evidence, or remove it; do not relabel an unsupported fact to bypass review.
- State each numerical limit's unit and scope. Distinguish model decisions, associated parallel tool batches, tool calls, tokens, cost and wall time; a per-agent limit does not establish a tree-wide cap.
- For sharing or revocation claims, identify the actor, resource, access route and revoked grant. Distinguish share grants from artifact/source/owner access and cached/offline copies. Test the promised access boundary; continued propagation of an already downloaded copy is not itself a link-revocation failure.
- Preserve publication and updated dates when both are present. Distinguish historical announcements, the currently read document and behavior actually tested. Retain account, platform, age, rollout and other scope qualifications; an updated page does not prove its present wording appeared in the original publication.
- Bound unknowns to what was actually read. A missing statement in a selected overview does not establish absence from all official documentation. A truncated result cannot support conclusions about omitted sections: read the needed passage or explicitly limit the claim. Keep unresolved source disagreements visible.
- For a substantial research or decision report, normally develop at least three complete reasoning chains: supported fact → relevance to the question → recommendation → tradeoff and observable acceptance condition. Scale the number and detail to short briefs without padding or inventing recommendations. Label proposed metrics as proposals, not sourced facts. Do not change the decision being argued midway; for example, default availability or callability is distinct from automatic generation. A third party's interface or control settings do not establish how this project must implement its own controls.
- External documentation cannot prove that this project has implemented, run or validated a workflow. Support execution claims with actual tool results and version receipts. Keep human-prepared research, model-authored content, deterministic export checks and application publication distinct; none alone certifies factual accuracy.

Resolve unsupported key assertions or disclose the remaining limitation before presenting the report as complete. This is content review within the existing workflow, not a new service, additional Agent, automatic fact certification or universal sharing gate. Keep source IDs in structured citations instead of manually repeating them in statement or cell text.

## Generate, verify and publish

Use a fresh output directory:

```sh
python3 /skills/report/scripts/generate_report.py --source /workspace/report.source.json --output-dir /workspace/report-output --formats html,md
node /skills/report/scripts/build-html.cjs /workspace/report-output/draft.html /workspace/report-output/report.html
node /skills/report/scripts/qa-html.cjs /workspace/report-output/report.html /workspace/report-output/qa
python3 /skills/report/scripts/verify_report.py --source /workspace/report.source.json --output-dir /workspace/report-output --formats html,md
```

HTML is required and becomes primary. Add docx and/or pdf when requested; use the identical format list for generation and verification. PDF uses the selected LibreOffice converter and an internal temporary DOCX. Deliver report.docx only when docx is requested. Missing dependencies, failed conversion or failed checks block completion. Do not remove a promised format, substitute a converter or reuse older outputs.

All exports derive from the same source. Check section/table order, text, numbers, units, uncertainty labels, citation membership and reference labels across formats. Inspect actual HTML screenshots with review_html_visuals. Inspect rendered DOCX/PDF pages when those formats are selected, following the main workflow. Structural/text verification does not replace factual or visual review. Exceeding the HTML QA height limit is a failure, not permission to ignore the tail.

Publish only after all promised files pass. report.html is primary; public MD/DOCX/PDF exports use role=asset, access=artifact. Preserve report.source.json as role=source, access=private. Never publish the scratchpad or provenance as a public export. Supply the checked final HTML digest to publish_artifact. Changes after checking require regeneration and verification. Report exactly which formats/checks completed and which real-service validation remains unavailable.

## Layout remains an explicit source choice

Presentation settings travel with the private editing source. A static contents list repeats only actual section headings; its navigation text is included in strict public-text verification. Source-note citations are intentional labeled notes associated with the relevant statement or cell, not unsupported footnotes or automatic evidence certification. Their source IDs and order must match the input exactly. Word/PDF page numbers are generated PAGE / NUMPAGES fields; the verifier permits only that controlled footer structure and rejects unrelated hidden/header/footer text. HTML/Markdown remain continuous documents. Every layout change requires fresh generation, format consistency checks and current visual inspection, including actual table continuation pages and the tail of each long report.

## Failed checks stop the attempt

If verification or HTML QA reports `passed: false`, stop downstream visual review and publication for that attempt and report the precise failures. This applies even when the execution wrapper reports success or `exitCode=0`. Visual acceptance cannot override content inconsistency, height overflow or another failed prerequisite. Do not append `; echo "QA_EXIT=$?"`, `; true`, or a successful command, or use a pipeline that hides the checker exit status. After a source or supported renderer fix, create a fresh output directory and obtain new verification and QA results before visual review. Keep the failed attempt as a negative sample; never inherit its screenshots or a different attempt's passed receipt.
