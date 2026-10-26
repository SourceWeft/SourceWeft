# HTML artifacts

HTML uses the existing artifact writer, version table, read handlers, UI registry, workspace authorization, sharing and sandbox file-transfer tools. `html-slides` and `html` are independent producers; neither owns a viewer or publication service.

`publish_artifact` accepts explicit `artifactType=html`, a complete self-contained UTF-8 file, optional preview/attachments and `expectedContentDigest`. HTML revisions also require the `expectedVersionNo` captured before editing. Basic validation runs against the same bytes handed to the writer; content/visual QA remains a separate generating-skill responsibility. There is no validation certificate or independent publication service.

The writer stores an immutable `artifact_versions.files_json` snapshot of actual uploaded files. Storage coordinates never come from model arguments. Source attachments remain private; only artifact-visible files enter browser projections. Explicit-version reads fail when the version has no snapshot, rather than reading current storage. File responses verify size and digest. A public share authorizes its current version only, rechecks every request and never exposes private authoring or historical bytes.

The HTML format registers its execution policy. Private file responses and public raw responses use sandbox CSP without same-origin, and the web proxy honors the trusted upstream policy marker. Generic `file` HTML and ordinary sub-assets remain inert. Preview/source/copy/download/fullscreen use the same registered HTML UI across app and share surfaces. Presentation controls depend on the `presentation/v1` declaration and a validated window/channel handshake, not a skill name or Reveal DOM.

## Page storage and links

Pages keep their sandbox: no same-origin, `connect-src 'none'`. When the host renders a file it adds `runtime=1`. The `/file` and public `/raw` routes then inject an inline runtime right after the `<html>` start tag. Downloads, the source view and the stored object keep the exact published bytes. The runtime does two things:

- It sends link clicks to the host, which shows a leave-SourceWeft confirmation and opens http(s) links in a new tab with `noopener,noreferrer`. Publish validation accepts `<a href>` values that are `#anchors` or absolute http(s) URLs only.
- It exposes `window.sourceweft.storage`, a client over a MessagePort. The page sends the first message. The host answers only its own iframe's first document from the opaque origin, and closes the port on any later `load`.

The host adds the rendered version. `POST /artifacts/:id/records` re-resolves workspace access, row visibility and the version's immutable `metadata.capabilities` on every call. It derives scope ownership from the session. Records live in `artifact_records` (one `jsonb` row per scope/owner/collection/id), keyed to the artifact, so they survive new versions.

- `user` rows belong to one viewer, whatever their role.
- `shared` rows need three things:
  - `storage.shared` in the version;
  - a person's approval for that exact version, from an editor or admin (`artifact_capability_approvals`);
  - the viewer's consent for that version (`artifact_record_consents`).

  Writing shared rows also needs editor.

- Public shares read only collections the owner lists in `share_links.public_record_collections`. They use the token and never a session, and they cannot write.

Page data can be exported and cleared by the people it belongs to, from the artifact preview panel. Both work on the artifact, not a version, and need no shared-storage approval:

- `GET /artifacts/:id/records/export?scope=user|shared[&collection=name]` streams one JSON document (`format`, `version`, `artifactId`, `scope`, `exportedAt`, `records[]` with scope, collection, id, data, etag and timestamps). Rows are read in keyset pages of 500 by collection and record id, so memory does not grow with the data; pages are not one snapshot. A failure part way errors the stream, so a truncated file is invalid JSON.
- `DELETE /artifacts/:id/records?scope=user|shared[&collection=name]` returns `{ "removed": n }`.
- `user` is always the caller's own records, for any member, viewers included; no input names another owner. `shared` needs the artifact's creator or a workspace admin, the rule share links use. The role guard leaves both paths to the handler.
- Both are audited as `artifact.records_exported` and `artifact.records_cleared` with scope, collection and counts, never the data, and are rate limited per viewer and artifact.

Queries run through a fixed DSL translated to parameterized SQL inside the caller's partition, with a statement timeout. Writes serialize per artifact for quota checks.

A page can still navigate its own frame and so send what it read to another site. No browser policy prevents that. Treat shared data as readable by whoever can get a version approved, which is why approval is per version and by a person.

## Generation runtime

Rebuild the existing Daytona/Cloudflare sandbox images with `docker/sourceweft-sandbox/html-runtime`. Both images expose:

- `SOURCEWEFT_HTML_RUNTIME=/opt/sourceweft-html`
- `SOURCEWEFT_HTML_FONTS=/opt/sourceweft-html-fonts`
- `NODE_PATH=/usr/local/lib/node_modules`

The shared installer pins parse5 7.3.0, PostCSS 8.5.26, postcss-value-parser 4.2.0, Playwright 1.59.1, fontTools 4.60.2 and Brotli 1.2.0. Fonts are pinned to the official Google Fonts commit and individual hashes in `fonts.json`, including licenses. Render jobs never install or download missing dependencies. Missing or mismatched runtime assets fail explicitly.

The generating skills contain bounded text/runtime bundles under the existing 200-file / 2 MiB skill limits; font binaries stay outside those bundles. Reveal and the visual library are pinned in the skill catalog. Chart.js 4.4.3 and highlight.js 11.10.0 preserve the upstream chart/code layouts offline. All notices accompany the generated file.

`prepare_sandbox_workspace` can stage the authorized primary file by artifact ID, optionally at an explicit version. Its `sourceArtifact` result records the exact version number and digest when a version snapshot exists. That number is the edit precondition. Staging uses the same actor-aware read boundary as normal private reads.

## Verification

The normal package tests cover schema, publication, policy, permissions, source projection, CAS and compatibility. PostgreSQL tests create temporary isolated databases and run full migrations. The HTML CI job additionally generates and checks all 36 themes, 31 layouts, 27 animations and 20 FX; three responsive page examples; two aspect ratios; browser compatibility; and third-page revision.

Browser QA checks real files in new offline contexts. It records source identity, viewports, errors, glyph coverage, screenshots and lifecycle metrics. It does not replace the configured model's visual review. The skill calls `review_html_visuals` for every required image batch and treats missing/incomplete/failed review as a failure. Optional source text and graphics cannot broaden iframe or server permissions.

Deploy the compatible schema/readers and rebuilt sandbox runtime before enabling generation. Disabling either skill leaves existing artifacts usable. Existing PPTX commands, types and preview behavior remain supported.

For cross-engine tests, Chromium uses `offline=true` before navigation. Firefox/WebKit cannot reliably fulfill a synthetic top-level response in that state, so their HTTP-policy tests intercept all requests before navigation and deny every real network request. Each engine also opens the actual local file. Chromium/Firefox use native offline mode there; WebKit uses the same all-network interception because its driver rejects local navigation with the offline flag. Reports record the strategy; WebKit coverage is not a claim of Safari device testing.
