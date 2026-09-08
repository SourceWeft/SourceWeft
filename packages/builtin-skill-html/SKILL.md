---
name: html
description: Create and revise polished self-contained HTML reports, landing pages, infographics and local interactive visualizations with responsive layout and final-file QA. Use the separate html-slides skill for paginated browser presentations.
---

# HTML pages

Create a complete offline `index.html` with semantic HTML, intentional typography, responsive layout and browser-local interactions. Use the existing artifact workflow and skill selection; no new product entry or mode selector.

1. Establish the audience, information hierarchy and expected interactions. Read `references/page-design.md` and `references/quality.md`.
2. Author a full UTF-8 document with an early charset declaration and viewport meta. Use normal document flow. Keep source, images and local scripts together in a sandbox project directory. Do not add Reveal, slide IDs, fixed presentation canvases or presentation font-size rules.
3. Confirm the provisioned `SOURCEWEFT_HTML_RUNTIME` and `SOURCEWEFT_HTML_FONTS` exist. Missing tooling, fonts or required model configuration must be reported; do not substitute runtime dependencies, system fonts or CDN assets.
4. Bundle the final document with `node /skills/html/scripts/build.cjs /workspace/draft.html /workspace/index.html`. Assets and selected fonts become part of the file. Use embedded font families from the provisioned catalog, or explicitly provision authorized custom fonts with their hashes and license information. Keep Canvas/SVG typography consistent with embedded fonts.
5. Run `node /skills/html/scripts/qa.cjs /workspace/index.html /workspace/qa`. Default viewports are 1440×900, 768×1024 and 390×844; inspect the whole page, including its tail. Interactive pages must supply a local `interaction-checks.cjs` module as the third argument. It exports an async function(page), asserts the requested behavior using the existing Playwright API, and returns true only after all checks pass. These are ordinary project tests, not a new platform protocol.
6. Run `review_html_visuals` against all generated viewport screenshots with task-specific criteria. Major visual defects, missing content, failed interactions, unavailable models and incomplete QA block delivery. Rebuild and recheck after any change.
7. Publish with `artifactType=html`, the actual final source file and the QA `expectedContentDigest`. An optional preview image can come from successful QA. Report only completed checks and the committed artifact/version.

# Revisions

Load the artifact through `prepare_sandbox_workspace`, specifying its artifact ID and a sandbox destination. Retain the returned `sourceArtifact.versionNo`; pass an explicit `artifactVersionId` when the user selected a historical version. Modify the relevant sections or functionality, rebuild, rerun QA and publish with `republishArtifactId` plus the captured `expectedVersionNo`. Do not silently overwrite a concurrent revision.

# Local execution

Use browser-local computation and state. The iframe has an opaque origin and cannot use the host's cookies or persistent storage. External services, login flows and multi-file website hosting need a separately agreed scope. The file must retain its content and interactions after this generating skill is disabled.
