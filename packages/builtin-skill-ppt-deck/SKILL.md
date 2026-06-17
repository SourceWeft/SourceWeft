---
name: ppt-deck
description: >
  Generate, edit, and read PowerPoint presentations. Create from scratch with
  PptxGenJS, edit existing PPTX via XML workflows, or extract text with
  markitdown. Triggers: PPT, PPTX, PowerPoint, presentation, slide, deck, slides.
argument-hint: "[topic, audience, template, or instructions]"
user-invocable: true
disable-model-invocation: false
---

# PPTX Generator & Editor

Create native editable PPTX decks with PptxGenJS in SourceWeft's sandbox. Keep
the workflow lean: understand the request, plan the deck, write one safe
`deck.js`, syntax-check it, generate the PPTX, QA the actual output, then
publish the PPTX artifact.

Do not use a fixed deck template or a complete example deck from this skill.
Every from-scratch deck needs topic-specific visual direction and varied slide
composition.

## Quick Reference

Required reads:

- Before creating, editing, writing, preparing, or executing any PPTX
  generation code, read [pptxgenjs.md](references/pptxgenjs.md). Do not write
  `/workfiles/ppt-deck/deck.js`, call `prepare_sandbox_workspace`, or run
  `execute` for deck generation until you have read that file in this turn.
- Before retrying after a syntax, runtime, rendering, output-path, or QA
  failure, read [pitfalls.md](references/pitfalls.md). Use it to identify the
  concrete failure class before editing again.
- Read the other reference files only when the task needs that kind of
  guidance.

| File                                            | Use when                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| [pptxgenjs.md](references/pptxgenjs.md)         | Required before writing or executing PPTX generation code               |
| [design-system.md](references/design-system.md) | You need palettes, typography, spacing, or visual motif guidance        |
| [slide-types.md](references/slide-types.md)     | You need slide type and layout pattern ideas                            |
| [editing.md](references/editing.md)             | You are editing an existing PPTX/template                               |
| [pitfalls.md](references/pitfalls.md)           | Required before retrying after generation, output, or QA failures       |

SourceWeft runtime notes:

- Write one `/workfiles/ppt-deck/deck.js` file, then prepare it to
  `/workspace/ppt-deck/deck.js`.
- Define `OUTPUT_DIR` and `PPTX_PATH` explicitly.
- Create `OUTPUT_DIR` in the script with
  `fs.mkdirSync(OUTPUT_DIR, { recursive: true })` before writing the PPTX.
- Run `node --check /workspace/ppt-deck/deck.js` before executing the script.
  This is mandatory and must happen before `node /workspace/ppt-deck/deck.js`.
- Only after syntax check passes, run `node /workspace/ppt-deck/deck.js`.
- After `writeFile` succeeds, print:

```text
PPTX generated: /workspace/ppt-deck/output/deck-slug.pptx
PPTX_ARTIFACT_PATH=/workspace/ppt-deck/output/deck-slug.pptx
PPTX_ARTIFACT_BYTES=156753
```

Treat `PPTX_ARTIFACT_PATH` as the source of truth for QA and publishing.
`PPTX_ARTIFACT_PATH` must be a complete absolute sandbox path ending in
`.pptx`; do not print a directory, basename without extension, or truncated
path.
Do not call `collect_sandbox_outputs` for `.pptx` files. PPTX is a normal
binary artifact; publish the sandbox path directly with
`publish_sandbox_artifact`.

Minimum safe script skeleton:

```javascript
const fs = require("fs");
const path = require("path");
const pptxgen = require("pptxgenjs");

const OUTPUT_DIR = "/workspace/ppt-deck/output";
const PPTX_PATH = path.join(OUTPUT_DIR, "deck-slug.pptx");

const text = (value) => String(value ?? "");

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const pres = new pptxgen();
  pres.layout = "LAYOUT_16X9";
  pres.author = "SourceWeft";
  pres.subject = "Presentation";
  pres.title = text("Presentation Title");

  const slide = pres.addSlide();
  slide.addText(text("Presentation Title"), {
    x: 0.7,
    y: 0.7,
    w: 8.6,
    h: 0.6,
    fontSize: 30,
    bold: true,
    margin: 0,
  });

  await pres.writeFile({ fileName: PPTX_PATH });
  const bytes = fs.statSync(PPTX_PATH).size;
  console.log(`PPTX generated: ${PPTX_PATH}`);
  console.log(`PPTX_ARTIFACT_PATH=${PPTX_PATH}`);
  console.log(`PPTX_ARTIFACT_BYTES=${bytes}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

## Reading Content

For existing decks, templates, or user-provided PPTX files:

1. Extract readable text with `markitdown`.
2. Inspect slide structure before changing it.
3. Preserve useful formatting, images, and layout logic unless the user asks for
   a redesign.
4. Use [editing.md](references/editing.md) for XML/template workflows.

For source-grounded decks, use the available source tools first and keep factual
claims traceable to the user's provided material.

## Editing Workflow

1. Identify the user-visible change and the deck path.
2. Read [pptxgenjs.md](references/pptxgenjs.md), then extract text and inspect
   the relevant slides.
3. Make the smallest reliable edit that satisfies the request.
4. Regenerate or modify the PPTX.
5. Run content QA and visual QA on the final file.
6. Publish only the final edited PPTX.

## Creating From Scratch

1. Identify audience, goal, language, slide count, tone, and source material. Use
   runtime config if present, but do not add new user-visible options.
2. Before coding, decide a short art direction: topic mood, visual metaphor,
   palette, typography, asset types, and how slide layouts will vary.
3. Build a coherent narrative, not a list of disconnected bullets.
4. Read [pptxgenjs.md](references/pptxgenjs.md), then write one
   `/workfiles/ppt-deck/deck.js` file.
5. Prepare it to `/workspace/ppt-deck/deck.js`.
6. Run `node --check /workspace/ppt-deck/deck.js`.
7. Run `node /workspace/ppt-deck/deck.js` only after syntax check passes.
8. QA the actual `PPTX_ARTIFACT_PATH`.
9. Publish with `publish_sandbox_artifact` using `artifactType: "slides"`.

Code safety:

- Complex natural-language text, especially user-provided text, Chinese text,
  quotes, examples, and multiline content, must enter JS through a safe literal
  strategy. Use `JSON.stringify(value)`, single quotes, template literals when
  safe, external JSON, or centralized constants rather than fragile inline quote
  juggling.
- When building strings inside `deck.js`, prefer constants, arrays, or a helper
  such as `const text = (value) => String(value ?? "")`. Do not inline Chinese
  or quoted prose into JavaScript string literals unless it has been escaped
  safely.
- Do not rely on a blacklist of bad phrases. Guard the path from natural
  language into executable code.
- If `node --check` fails twice, enter minimal repair mode: inspect the reported
  line/column and fix only syntax boundaries, escaping, missing delimiters, or
  neighboring punctuation. Do not redesign slides during syntax repair.
- If full execution fails twice, summarize the concrete error class before
  editing again. Before that next edit, read
  [pitfalls.md](references/pitfalls.md).

## Design Ideas

- Avoid pure white title-and-bullet decks unless the user asks for a rough
  outline.
- Every content slide should include a useful visual element: image, chart,
  icon, native shape illustration, process, comparison, timeline, data view, or
  diagram.
- Choose colors that fit the topic. Do not default to generic blue.
- Use a clear palette hierarchy: dominant color, supporting colors, accent
  color, and reading background.
- Vary layouts across the deck while keeping one coherent visual system.
- Avoid repeated title underline accents, low-contrast text, cramped spacing,
  oversized body copy, and accidental empty zones.
- If the plan, slide title, caption, or body promises a visual element such as a
  portrait, person, blackboard, chart, screenshot, photo, notebook, diagram, or
  logo, the final PPTX must visibly include that element. If a reliable asset is
  unavailable, replace the promise with a native shape illustration, icon,
  silhouette, abstract diagram, or remove the promise.

Use [design-system.md](references/design-system.md) and
[slide-types.md](references/slide-types.md) for inspiration, not as a fixed
template.

## QA Required

Use the exact path printed by `PPTX_ARTIFACT_PATH=...`.

```bash
PPTX_ARTIFACT_PATH="<path printed by deck.js>"
QA_DIR="/workspace/ppt-deck/qa"
mkdir -p "$QA_DIR"
python3 -m markitdown "$PPTX_ARTIFACT_PATH" > "$QA_DIR/content.txt"
python3 -m markitdown "$PPTX_ARTIFACT_PATH" | grep -iE "xxxx|lorem|ipsum|placeholder" || true
soffice --headless --convert-to pdf --outdir "$QA_DIR" "$PPTX_ARTIFACT_PATH"
pdftoppm -jpeg -r 150 "$QA_DIR/<deck-slug>.pdf" "$QA_DIR/slide"
```

Inspect rendered slide images or a contact sheet for:

- text clipping, overlap, or low contrast
- monotonous repeated layouts
- promised visual elements that are missing
- text-only content slides
- leftover placeholder content

If `PPTX_ARTIFACT_PATH` is missing or invalid, run one fallback discovery
command:

```bash
find /workspace/ppt-deck -type f -iname '*.pptx'
```

If fallback finds exactly one PPTX, use it for QA and publishing. Otherwise rerun
the deck program with the required stdout protocol instead of guessing.

Publish only after syntax check, PPTX generation, content QA, and visual QA pass:

```json
{
  "artifactType": "slides",
  "title": "Presentation Title",
  "description": "Brief presentation description",
  "source": {
    "kind": "sandbox_path",
    "path": "<path printed by PPTX_ARTIFACT_PATH>"
  },
  "qa": {
    "contentChecked": true,
    "visualChecked": true,
    "warnings": []
  }
}
```

## Converting To Images

When visual inspection is needed, convert the generated PPTX to PDF with
LibreOffice and render slide images with `pdftoppm`. Use the rendered output to
catch overlap, clipping, poor contrast, repeated layouts, and missing visual
elements. Do not publish based on text extraction alone.

## Dependencies

The sandbox image preinstalls Node.js, npm, Python 3, LibreOffice, poppler-utils,
CJK fonts, `pptxgenjs`, and `sharp`.
