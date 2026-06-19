# QA Process & Common Pitfalls

Read this before retrying after any syntax, runtime, output-path, rendering, or
visual QA failure. First classify the failure, then fix that class. Do not
redesign slides while repairing syntax or sandbox path problems.

## Failure Map

| Error or symptom | Likely cause | Repair |
| --- | --- | --- |
| `SyntaxError: missing ) after argument list` near Chinese text | Nested quotes broke a JS string | Move text into `DATA`; use template strings and visible curly quotes |
| `SyntaxError: Unexpected identifier 'O环'` | `"O环"` ended a string early | Write `挑战者号事故调查中的“O环”演示` inside a template string |
| `SyntaxError` near `简化 -> 复述 -> 纠错` | Text was pasted into code without safe literal boundary | Put the full sentence in `DATA.loop` and call `txt(DATA.loop)` |
| `UNKNOWN-LAYOUT` | Wrong PptxGenJS layout name | Use `pres.layout = "LAYOUT_16x9"` exactly |
| `Cannot create property 'options' on string` | Raw string mixed into rich text array | Use `slide.addText("✓", opts)` separately or `rich([{ text, options }])` |
| `newObject.text.forEach is not a function` | Invalid first argument to `addText` | Pass a string or a rich text array only |
| Error says a Workfile path is not a sandbox path | Confused SourceWeft Workfiles with sandbox filesystem | Use sandbox workspace paths in `execute`; create Workfiles with SourceWeft file tools, then prepare them |
| `SANDBOX_EXECUTE_COMMAND_DENIED: command contains control characters` | Command contains NUL or another unsafe control character | Remove the unsafe character; multiline shell commands are allowed |
| `PPTX_ARTIFACT_PATH` missing | Program did not print the required stdout protocol | Add the required `console.log` lines after `writeFile` |
| LibreOffice render fails | Bad PPTX, missing file, or sandbox render issue | Verify path, rerun generation, then convert the actual artifact path |
| Slides look like text documents | No primary visual/background strategy | Rebuild storyboard using slide types and visual scorecard |

## Syntax Repair Mode

If `node --check` fails:

1. Inspect the exact line and neighboring strings.
2. Fix only string boundaries, delimiters, commas, brackets, or invalid API
   argument shapes.
3. Do not change palette, layout, or story during syntax repair.
4. If syntax check fails twice, move all long natural-language text into a
   single `DATA` object and reference it through `txt(DATA.key)`.

Use this pattern:

```javascript
const DATA = {
  title: `为什么“讲出来”能让你真正学会`,
  loop: `形成一个“简化 -> 复述 -> 纠错”的循环，知识才会真正留下。`,
  event: `挑战者号事故调查中的“O环”演示`,
};

slide.addText(txt(DATA.title), titleOpts);
slide.addText(txt(DATA.loop), bodyOpts);
```

Do not keep patching inline strings like:

```javascript
slide.addText("为什么"讲出来"能让你真正学会", titleOpts);
```

## Sandbox Path Rules

Follow the sandbox runtime rules for Workfiles, prepare, and command execution.
The deck builder, source data, and other command inputs should start as
Workfiles, then be prepared into the sandbox workspace before `execute` uses
them. Do not assume Workfiles are mounted inside command execution.

## QA Process

**Assume there are problems. Your job is to find them.**

First renders are rarely correct. Approach QA as a bug hunt, not a confirmation
step. If you found zero issues on first inspection, look again for weak
backgrounds, repeated layouts, clipped text, and fake visuals.

### Content QA

Always use the actual sandbox path printed by the deck program:

```bash
python3 -m markitdown <actual-generated-pptx-path>
```

Check for:

- missing or out-of-order content
- typos
- placeholder text
- promised visuals that are mentioned in text but absent in the rendered deck

Placeholder check:

```bash
python3 -m markitdown <actual-generated-pptx-path> | grep -iE "xxxx|lorem|ipsum|placeholder|this.*(page|slide).*layout"
```

### Visual QA

Render the actual PPTX before publishing. Text extraction cannot catch overlaps,
clipped boxes, weak backgrounds, poor contrast, or monotonous layouts.

The logical steps are:

```bash
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

echo "===VISUAL_QA_SUMMARY==="
echo "Inspect the rendered slide JPG files listed above before publishing."
```

The preview image for a slides artifact is the first rendered slide from the
final PPTX QA pass. Provide the printed `PREVIEW_IMAGE_PATH` to the configured
artifact publisher, and never publish a preview from a stale or intermediate
render.

Use the discovered JPG filenames for inspection or contact sheets. Do not assume
the renderer will produce `slide-01.jpg`; some environments produce names such
as `slide-1.jpg`. Do not use `file` as a required QA step; it is only an
optional, guarded diagnostic when available.

Inspect slide JPG files or a contact sheet for:

- overlapping elements: text through shapes, lines through words, stacked elements
- text overflow or cut off at edges/box boundaries
- decorative lines positioned for single-line titles after title wrap
- source notes, captions, or footers colliding with content above
- elements too close together; keep at least 0.3" gaps between major blocks
- insufficient slide-edge margins; keep about 0.5" unless using full-bleed media
- columns, cards, or similar elements not aligned consistently
- low-contrast text, icons, chart labels, or footnotes
- pure text slides or tiny fake visuals
- three or more repeated layout classes in a row
- cramped content or large accidental empty zones
- text boxes too narrow, causing excessive wrapping
- missing promised assets, charts, blackboards, notebooks, screenshots, logos, or diagrams
- leftover placeholder content

### Fresh-Eyes Prompt

Use this prompt when inspecting slide images yourself or with another agent:

```text
Visually inspect these slides. Assume there are issues and find them.

Look for:
- Overlapping elements: text through shapes, lines through words, stacked elements
- Text overflow or cut off at edges/box boundaries
- Decorative lines positioned for single-line text but title wrapped to two lines
- Captions, citations, or footers colliding with content above
- Elements too close together, especially gaps under 0.3"
- Insufficient margin from slide edges, especially under 0.5"
- Columns, cards, or repeated elements not aligned consistently
- Low-contrast text, icons, charts, and labels
- Text boxes too narrow causing excessive wrapping
- Pure text slides or tiny icons used as fake primary visuals
- Missing promised visuals such as charts, screenshots, notebooks, blackboards, logos, or diagrams
- Leftover placeholder content

For each slide, list issues or areas of concern, even if minor.
```

## Verification Loop

1. Run `node --check`.
2. Generate the deck.
3. Extract content from the actual `PPTX_ARTIFACT_PATH`.
4. Render slides to images.
5. List issues found.
6. Fix the Workfile builder, prepare it again, and rerun checks.
7. Re-verify affected slides or the full deck.

Do not publish until at least one fix-and-verify cycle is complete.

## Common Visual Mistakes

- Repeating the same layout across the deck.
- Center-aligning body paragraphs.
- Using title underline accents.
- Using generic blue without topic fit.
- Making only the cover beautiful.
- Using one tiny icon beside text as the visual.
- Shrinking paragraphs instead of redesigning as structure.
- Low-contrast gray text on cream, pale blue, or dark backgrounds.
- Leaving white backgrounds with bullet lists.

## Critical PptxGenJS Pitfalls

### Always await PPTX writes

```javascript
// Wrong
pres.writeFile({ fileName: PPTX_PATH });

// Correct
async function main() {
  await pres.writeFile({ fileName: PPTX_PATH });
}
```

### Use exact layout names

```javascript
pres.layout = "LAYOUT_16x9"; // Correct
pres.layout = "LAYOUT_16X9"; // Wrong: UNKNOWN-LAYOUT
```

### Never use `#` or 8-character hex colors

```javascript
color: "FF0000"; // Correct
color: "#FF0000"; // Wrong
shadow: { color: "000000", opacity: 0.12 }; // Correct
shadow: { color: "00000020" }; // Wrong
```

### Safe `addText` values

```javascript
// Correct
slide.addText("✓", { x: 1, y: 1, w: 0.3, h: 0.3 });
slide.addText(rich([{ text: "Done", options: { bold: true } }]), { x: 1.4, y: 1, w: 2, h: 0.3 });

// Wrong
slide.addText({ text: "Done" }, { x: 1, y: 1, w: 2, h: 0.3 });
slide.addText(["✓", { text: "Done" }], { x: 1, y: 1, w: 2, h: 0.3 });
```

### Do not reuse option objects across PptxGenJS calls

PptxGenJS mutates options. Use factories or clone fresh objects.

```javascript
const makeShadow = () => ({ type: "outer", blur: 6, offset: 2, color: "000000", opacity: 0.15 });
slide.addShape(pres.shapes.RECTANGLE, { shadow: makeShadow(), ... });
slide.addShape(pres.shapes.RECTANGLE, { shadow: makeShadow(), ... });
```
