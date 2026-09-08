---
name: html-slides
description: Create and revise offline HTML presentations with Reveal, polished themes, layouts, fragment animation and visual effects. Use for browser-native slides and shareable interactive presentations. PowerPoint files remain the ppt-deck skill's responsibility.
---

# HTML presentations

Produce one complete, offline `index.html` through the existing artifact workflow. The file contains its player, assets, scripts and embedded fonts. Use the selected skill normally; do not introduce a studio, new command or product mode selector.

1. Plan the story and page roles. Default to 1280×720 / 16:9, support 4:3 on request, 1–40 pages. Body text must be at least 24px in the unscaled design. Reorganize or split dense content.
2. Read `references/design.md` and the relevant files from `runtime/layouts/` and `runtime/themes/`. `runtime/catalog.json` enumerates all 36 themes, 31 layouts, 27 animations and 20 FX; use only real entries. Read effects guidance when needed.
3. Prepare files in the provider sandbox using existing tools. Confirm `SOURCEWEFT_HTML_RUNTIME`, `SOURCEWEFT_HTML_FONTS` and the pinned Node/Python/browser tools exist. A missing runtime is a deployment error: report it; never install a different version, switch fonts or use a CDN to continue.
4. Create a starter when helpful: `node /skills/html-slides/scripts/build.cjs /workspace/draft.html --layout=two-column --starter`. Edit its real content with the sandbox tools; add flat `section` pages with stable `data-slide-id`. Keep custom assets inside the project directory.
5. Build: `node /skills/html-slides/scripts/build.cjs /workspace/draft.html /workspace/index.html --theme=minimal-white --ratio=16:9`. This embeds resources and fonts. The theme and ratio are generation details, not product UI modes.
6. Run final-file QA: `node /skills/html-slides/scripts/qa.cjs /workspace/index.html /workspace/qa`. It checks offline loading, actual glyph coverage, page layout, deterministic captures and lifecycle cleanup. Fix reported problems and rebuild. Do not treat a screenshot's existence as QA success.
7. Use `review_html_visuals` on every image listed in `/workspace/qa/qa.json`, in batches of at most 24. Criteria must include readability, hierarchy, balance, content completeness and the intended visual effect. Major/critical issues, missing vision configuration, exceptions or incomplete results block delivery. Review all batches; do not extrapolate one page's pass to the deck.
8. Publish the exact final file using `publish_artifact` with `artifactType=html`, the final `expectedContentDigest`, and every public image attachment from `/workspace/qa/attachments.json`. The presentation metadata names these thumbnails; omitting them is an error. Use the first image as optional `previewImage` for the artifact card. Report the committed artifact/version, page count and actual QA result.

# Revisions

Use `prepare_sandbox_workspace` with `{artifactId, sandboxPath:'/workspace/current.html'}`. For an explicitly requested history version, also provide `artifactVersionId`. Keep the returned `sourceArtifact.versionNo` as the editing baseline; do not guess it or reread a newer number just before publishing.

Resolve “change page 3” by the order of sections in the version you loaded, then edit that section's stable ID. Preserve other page IDs, the presentation metadata and its required image names. Rebuild from the modified full HTML, rerun all required QA, and publish with `republishArtifactId` and the captured `expectedVersionNo`. A conflict requires reloading and reconciling edits. The complete HTML is a valid revision source; do not invent a private project file.

# Delivery boundaries

All styling, animations, effects and controls live in the file. Reveal is the sole player. The included adapter implements `presentation/v1` for optional host controls; a plain iframe and the downloaded file must work without a host handshake. Preview/share read the finished artifact and never load this skill at viewing time.

Source HTML, QA screenshots and process notes may stay in the sandbox or Workfiles for follow-up. Publish the real file; never claim the workspace path itself is a delivered artifact. Do not claim visual checks that were not run.
