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

Each source has a unique report-local ID such as `S1`, matching `S` followed by a positive integer, independent of turn-local `c1`. Citations contain these IDs. Sources have `display: { title, locator?, url? }` and optional private `provenance`. The provenance fields `sourceId`, `documentId`, `chunkId`, `fileId`, `scope`, `revision` and `locator` are optional strings; use only observed values. Do not insert arbitrary objects or invented identities. A saved source is an editing record, not authority to access data.

## Separate public references from private provenance

Public display fields contain human-readable titles, actually observed page/section/table locations and actual HTTP(S) URLs. Do not include URL credentials. For internal material without a public URL, keep the title and useful observed locator without manufacturing a SourceWeft link.

Keep internal IDs, file revisions and machine identity in private provenance. Never emit `/kb`, `/files`, workspace/thread/file/chunk IDs, storage coordinates, runtime markers or raw identity JSON into public report text and references. Inspect all public text fields, including titles, tables and display.locator: omitting the provenance object alone does not sanitize copied confidential text.

Escaping text prevents executable markup; it does not determine whether the text should be disclosed. Review the report's actual source disclosure before publishing.

## Generate, verify and publish

Use a fresh output directory:

```sh
python3 /skills/report/scripts/generate_report.py --source /workspace/report.source.json --output-dir /workspace/report-output --formats html,md
node /skills/report/scripts/build-html.cjs /workspace/report-output/draft.html /workspace/report-output/report.html
node /skills/report/scripts/qa-html.cjs /workspace/report-output/report.html /workspace/report-output/qa
python3 /skills/report/scripts/verify_report.py --source /workspace/report-output/report.source.json --output-dir /workspace/report-output --formats html,md
```

HTML is required and becomes primary. Add docx and/or pdf when requested; use the identical format list for generation and verification. PDF uses the selected LibreOffice converter and an internal temporary DOCX. Deliver report.docx only when docx is requested. Missing dependencies, failed conversion or failed checks block completion. Do not remove a promised format, substitute a converter or reuse older outputs.

All exports derive from the same source. Check section/table order, text, numbers, units, uncertainty labels, citation membership and reference labels across formats. Inspect actual HTML screenshots with review_html_visuals. Inspect rendered DOCX/PDF pages when those formats are selected, following the main workflow. Structural/text verification does not replace factual or visual review. Exceeding the HTML QA height limit is a failure, not permission to ignore the tail.

Publish only after all promised files pass. report.html is primary; public MD/DOCX/PDF exports use role=asset, access=artifact. Preserve report.source.json as role=source, access=private. Never publish the scratchpad or provenance as a public export. Supply the checked final HTML digest to publish_artifact. Changes after checking require regeneration and verification. Report exactly which formats/checks completed and which real-service validation remains unavailable.
