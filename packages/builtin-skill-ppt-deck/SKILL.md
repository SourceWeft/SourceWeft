---
name: ppt-deck
description: >
  Generate, edit, and read PowerPoint presentations. Create polished decks from
  scratch with PptxGenJS, edit existing PPTX/POTX via XML workflows, or extract
  text with markitdown. Triggers: PPT, PPTX, POTX, PowerPoint, presentation,
  slide, deck, slides.
argument-hint: "[topic, audience, template, or instructions]"
user-invocable: true
disable-model-invocation: false
---

# PPTX Generator & Editor

Create native editable PPTX decks in SourceWeft's sandbox. Keep the default path
short: route the task, read only the one reference that applies, write one
generation script, run one generation phase, run one QA phase, then publish.

From-scratch decks must feel like finished presentations, not documents split
across slides. Use topic-specific visual direction and varied slide structures,
but do not use this skill's examples as a fixed template.

## Runtime Options

When `<skill_runtime_config name="ppt-deck">` is present in the runtime
context, treat those values as user-selected generation constraints:

- `slideCount`: target number of slides for the finished deck.
- `language`: main deck language; `auto` means infer from the user's request.
- `visualDensity`: how much information each slide should carry.
- `stylePreset`: visual direction for layout, typography, and tone.

When `stylePreset` is set, map it to a design-system theme preset:

| stylePreset | Theme preset | Palette anchor |
| --- | --- | --- |
| auto | Pick by topic via the Topic-to-Preset Map in design-system.md | — |
| executive | Executive Strategy | charcoal/navy + gold accent |
| product | Product Launch | launch navy + coral accent |
| academic | Academic Explainer | deep teal + warm cream surfaces |
| training | Learning Studio | blackboard green + sticky yellow |
| minimal | Minimal Focus | white + ink + one topic accent |
| editorial | Editorial Print | paper white + ink + serif display |

With `auto`, keep the default reading path. With any other value, read the
mapped preset's section in [design-system.md](references/design-system.md)
and apply its palette, motif, background rhythm, and layout mix; the user
picked it, so it outranks topic-based preset selection.

Follow these options unless they conflict with higher-priority system rules or
the user's latest explicit request.

## Quick Reference

| Task | What to do |
| --- | --- |
| Read or analyze a PPTX | Use `python3 -m markitdown <deck.pptx>` |
| Edit an existing deck/template | Read [editing.md](references/editing.md) |
| Create a deck from scratch | Read [pptxgenjs.md](references/pptxgenjs.md) |

Default create-from-scratch work should read only `pptxgenjs.md`. Default
template/editing work should read only `editing.md`. Read optional references
only when the request or a concrete failure requires them:

- [pitfalls.md](references/pitfalls.md): after a real syntax, runtime,
  output-path, rendering, or QA failure.
- [visual-quality.md](references/visual-quality.md): when first render is weak
  or the user asks for polished, executive, or visual redesign quality.
- [design-system.md](references/design-system.md) and
  [slide-types.md](references/slide-types.md): when visual direction or layout
  selection is genuinely stuck.
- [background-recipes.md](references/background-recipes.md): for large visual
  fields, background-heavy decks, or custom background recipes.
- [asset-strategy.md](references/asset-strategy.md): for photos, screenshots,
  logos, icons, or generated/procedural assets.

## Create From Scratch

1. Read [pptxgenjs.md](references/pptxgenjs.md).
2. Draft the storyboard mentally or in the response; do not create planning
   files, QA ledgers, or manifests unless the user asks.
3. Create one deck builder script as a Workfile, then prepare it into the
   sandbox workspace according to the sandbox runtime rules.
4. Run one generation `execute`: confirm the prepared builder exists, run
   `node --check`, then run the builder.
5. Run one QA `execute`: extract content with `markitdown`, run File QA with
   `scripts/validate_pptx.py`, convert the PPTX to PDF with LibreOffice, render
   images with `pdftoppm`, create the preview image contract from the first
   rendered slide, then print explicit stage markers, `QA_IMAGE_COUNT`,
   `PREVIEW_IMAGE_PATH`, and the discovered slide image paths.
6. Call `review_deck_visuals` with the slide image paths from final QA; repair
   severe verdicts once as described in the QA section.
7. Use the actual generated PPTX path for QA and publishing.
8. Fix concrete issues only. If QA passes, publish without an extra repair loop.
9. Publish with the configured artifact publisher using the actual generated
   PPTX path and the `PREVIEW_IMAGE_PATH` from final QA.

Build a coherent narrative with one point per slide. Prefer process diagrams,
comparisons, concept maps, data views, framework canvases, case/example slides,
mixed-media layouts, recap matrices, and principle/quote posters over ordinary
title-and-bullet pages.

## Edit Existing Decks

1. Read [editing.md](references/editing.md).
2. Extract readable text with `markitdown`.
3. Inspect slide structure before changing it.
4. Preserve useful formatting, images, and layout logic unless the user asks for
   a redesign.
5. Make the smallest reliable edit that satisfies the request.
6. Run content QA, File QA, and `review_deck_visuals` on the final file. For
   template-derived decks, pass `--original` to `validate_pptx.py`.
7. Publish only the final edited PPTX.

For source-grounded decks, use the available source tools first and keep factual
claims traceable to the user's provided material.

## Hard Gotchas

These corrupt files or make PowerPoint refuse the deck. Follow them even if you
only read this SKILL.md:

- Hex colors: 6 digits, no `#`, no 8-digit alpha in the hex string.
- Shadows: `opacity` 0-1, never bake alpha into `color`; `offset` must be >= 0.
- Do not reuse PptxGenJS option objects across `add*` calls; clone fresh ones.
- Keep charts native with `addChart`. On stacked/percentStacked bar or column
  charts, never use `dataLabelPosition: "outEnd"` — use `ctr`, `inEnd`, or
  `inBase`. Combo/secondary-axis charts need matching `valAxes` and `catAxes`.
- Put long or quoted natural-language text in a `DATA` object and pass
  `txt(DATA.key)` into drawing calls.
- Prefer QA-safe fonts for body text: Arial, Calibri, Cambria, Times New Roman,
  Courier New, plus Microsoft YaHei for Chinese. Do not default to Aptos.

## Design Guardrails

- Do not create plain white bullet decks unless the user asks for a rough
  outline.
- Do not default to generic blue unless it fits the topic.
- Do not repeat title-and-bullet layouts across the deck.
- Do not use title underline accents as the main visual system.
- Do not use decorative color bars, header/footer stripes, sidebar stripes, or
  card edge stripes. Separate regions with background tint, shadow, icon badges,
  or split fields instead.
- Do not default to cream/beige backgrounds. When no brand palette is given, use
  white (`FFFFFF`) or a topic-specific dominant color. Cream is allowed only as
  an intentional theme surface (for example Learning Studio or Academic
  Explainer), never as a lazy default.
- Every content slide needs a meaningful visual structure: native diagram,
  comparison, timeline, process, chart, image, icon system, or shaped layout.
- Use strong contrast, comfortable margins, and varied but coherent layouts.
- If slide text promises a portrait, photo, blackboard, chart, screenshot,
  notebook, logo, or diagram, the final PPTX must visibly include it or the
  promise must be removed.

## QA

Use the exact path printed by the deck builder.

Generation phase:

```bash
test -f "<prepared sandbox builder path>"
node --check "<prepared sandbox builder path>"
node "<prepared sandbox builder path>"
```

QA phase:

```bash
set -e
PPTX_ARTIFACT_PATH="<path printed by deck.js>"
QA_DIR="<sandbox QA directory>"
VALIDATE_PPTX="/skills/ppt-deck/scripts/validate_pptx.py"
mkdir -p "$QA_DIR"

echo "===CONTENT_QA==="
python3 -m markitdown "$PPTX_ARTIFACT_PATH" > "$QA_DIR/content.txt"
python3 -m markitdown "$PPTX_ARTIFACT_PATH" | grep -iE '\bx{3,}\b|lorem|ipsum|placeholder|\bTODO\b|\[insert|this.*(page|slide).*layout' || true

echo "===FILE_QA==="
python3 "$VALIDATE_PPTX" "$PPTX_ARTIFACT_PATH"

echo "===PPTX_TO_PDF==="
soffice --headless --convert-to pdf --outdir "$QA_DIR" "$PPTX_ARTIFACT_PATH"
PDF_PATH="$(find "$QA_DIR" -maxdepth 1 -type f -iname '*.pdf' | head -n 1)"
test -s "$PDF_PATH"
echo "PDF_PATH=$PDF_PATH"

echo "===PDF_TO_JPG==="
pdftoppm -jpeg -r 150 "$PDF_PATH" "$QA_DIR/slide"
find "$QA_DIR" -maxdepth 1 -type f -name 'slide*.jpg' | sort > "$QA_DIR/slide-images.txt"
QA_IMAGE_COUNT="$(wc -l < "$QA_DIR/slide-images.txt" | tr -d ' ')"
echo "QA_IMAGE_COUNT=$QA_IMAGE_COUNT"
test "$QA_IMAGE_COUNT" -gt 0
cat "$QA_DIR/slide-images.txt"
PREVIEW_SOURCE_PATH="$(head -n 1 "$QA_DIR/slide-images.txt")"
test -s "$PREVIEW_SOURCE_PATH"
cp "$PREVIEW_SOURCE_PATH" "$QA_DIR/preview.jpg"
echo "PREVIEW_IMAGE_PATH=$QA_DIR/preview.jpg"
```

After the QA execute completes, call `review_deck_visuals` with the image
paths from `$QA_DIR/slide-images.txt`, in deck order. This judges the rendered
slides with the workspace's vision model against the deck rubric (overflow,
overlap, low contrast, decorative stripes, cream defaults, bullet-only pages,
missing promised visuals, repeated layouts):

- Severe issues: fix the deck builder, then rerun generation + QA once.
- Minor issues and deck findings: fix them if a repair round is happening
  anyway; otherwise note them in the publish `qa` summary.
- `{skipped, reason}`: visual QA is unavailable; record the reason in the
  publish `qa` summary and proceed.

The slides preview image is the first slide image rendered from the final PPTX
during final QA. Always provide the printed `PREVIEW_IMAGE_PATH` to the
configured artifact publisher; do not use a preview image from an earlier render
or an unverified intermediate PPTX.

Do not assume a fixed filename such as `slide-01.jpg`; use the files returned by
`find`. The QA log must make the conversion visible with `===CONTENT_QA===`,
`===FILE_QA===`, `===PPTX_TO_PDF===`, `===PDF_TO_JPG===`, `QA_IMAGE_COUNT=<n>`,
and `PREVIEW_IMAGE_PATH=<path>`. Do not publish when File QA fails,
`QA_IMAGE_COUNT` is zero, `PREVIEW_IMAGE_PATH` is missing, or
`review_deck_visuals` reported severe issues that have not been repaired. A
`skipped` visual QA does not block publishing, but its reason must appear in
the publish `qa` summary.

Do not run `file` against slide JPGs on the happy path. If a concrete debugging
failure needs MIME diagnostics, make that optional and non-blocking, and use the
discovered slide image paths from `$QA_DIR/slide-images.txt` instead of any
fixed QA directory.

If `PPTX_ARTIFACT_PATH` is missing or invalid, run one fallback discovery
command:

```bash
find "<sandbox task directory>" -type f -iname '*.pptx'
```

If fallback finds exactly one PPTX, use it for QA and publishing. Otherwise
rerun the deck program with the required stdout protocol instead of guessing.

## Toolcall Discipline

- Treat roughly 12 visible tool calls as the normal create-flow budget.
- Treat roughly 18 visible tool calls as the budget for one real repair loop.
- If visible tool calls approach 20, compress remaining work into the next
  decisive generation, QA, or publish action; report a blocker only when a
  concrete dependency or repeated failure prevents progress.
- Combine related shell steps into one `execute` per phase.
- Do not separately run repeated `ls`, `file`, `which`, `identify`, or generic
  environment probes on the happy path.
- Do not read optional references on the happy path.

## Failure Policy

- Syntax failure: inspect the exact error, patch `deck.js` once, then rerun the
  generation phase once.
- Runtime failure: read [pitfalls.md](references/pitfalls.md) only after a
  concrete generation failure.
- File QA failure: fix chart options or package structure in the generator, then
  regenerate; do not hand-edit packed XML to silence validate.
- QA failure: patch only affected slides/layouts, then rerun QA once.
- If `review_deck_visuals` returns severe verdicts (overflow, overlap, clipped
  or unreadable content, stripes through text), fix the deck builder first and
  rerender the affected slides or the full deck before publishing. One repair
  round, then publish with remaining findings recorded in the `qa` summary.
- Optional inspection tool missing: record a warning; do not probe repeatedly.
- Do not redesign slides while repairing syntax or sandbox path problems.

## Dependencies

The sandbox image preinstalls Node.js, npm, Python 3, LibreOffice, poppler-utils,
CJK fonts, `pptxgenjs`, `sharp`, `react`, `react-dom`, and `react-icons`. File QA
uses `/skills/ppt-deck/scripts/validate_pptx.py` from this skill bundle.
