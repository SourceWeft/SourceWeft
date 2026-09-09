# HTML artifacts

HTML uses the existing artifact writer, version table, read handlers, UI registry, workspace authorization, sharing and sandbox file-transfer tools. `html-slides` and `html` are independent producers; neither owns a viewer or publication service.

`publish_artifact` accepts explicit `artifactType=html`, a complete self-contained UTF-8 file, optional preview/attachments and `expectedContentDigest`. HTML revisions also require the `expectedVersionNo` captured before editing. Basic validation runs against the same bytes handed to the writer; content/visual QA remains a separate generating-skill responsibility. There is no validation certificate or independent publication service.

The writer stores an immutable `artifact_versions.files_json` snapshot of actual uploaded files. Storage coordinates never come from model arguments. Source attachments remain private; only artifact-visible files enter browser projections. Explicit-version reads fail when the version has no snapshot, rather than reading current storage. File responses verify size and digest. A public share authorizes its current version only, rechecks every request and never exposes private authoring or historical bytes.

The HTML format registers its execution policy. Private file responses and public raw responses use sandbox CSP without same-origin, and the web proxy honors the trusted upstream policy marker. Generic `file` HTML and ordinary sub-assets remain inert. Preview/source/copy/download/fullscreen use the same registered HTML UI across app and share surfaces. Presentation controls depend on the `presentation/v1` declaration and a validated window/channel handshake, not a skill name or Reveal DOM.

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
