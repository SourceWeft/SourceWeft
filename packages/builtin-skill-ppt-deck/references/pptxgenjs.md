# PptxGenJS Tutorial

## Setup & Basic Structure

```javascript
const fs = require("fs");
const path = require("path");
const pptxgen = require("pptxgenjs");

const PPTX_PATH = "<sandbox output pptx path>";

const txt = (value) => String(value ?? "");

const DATA = {
  title: `Presentation Title`,
  subtitle: `Why this matters`,
};

async function main() {
  fs.mkdirSync(path.dirname(PPTX_PATH), { recursive: true });

  const pres = new pptxgen();
  pres.layout = "LAYOUT_16x9";
  pres.author = "SourceWeft";
  pres.title = txt(DATA.title);

  const slide = pres.addSlide();
  slide.addText(txt(DATA.title), { x: 0.5, y: 0.5, fontSize: 36, color: "363636" });

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

## SourceWeft Generation Command

Create the builder as a Workfile, then prepare it into the sandbox workspace
according to the sandbox runtime rules. Run generation as one shell phase
instead of splitting each check into separate tool calls:

```bash
set -e
test -f "<prepared sandbox builder path>"
node --check "<prepared sandbox builder path>"
node "<prepared sandbox builder path>"
```

Run QA as one later shell phase using the exact `PPTX_ARTIFACT_PATH` printed by
the program:

```bash
set -e
PPTX_ARTIFACT_PATH="<path printed by deck.js>"
QA_DIR="<sandbox QA directory>"
mkdir -p "$QA_DIR"

echo "===CONTENT_QA==="
python3 -m markitdown "$PPTX_ARTIFACT_PATH" > "$QA_DIR/content.txt"
python3 -m markitdown "$PPTX_ARTIFACT_PATH" | grep -iE "xxxx|lorem|ipsum|placeholder" || true

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
echo "Inspect the rendered slide JPG files listed above for overlap, clipping, odd wraps, decorative lines through text, low contrast, cramped margins, and missing promised visuals before publishing."
```

The slides preview image is the first rendered slide from the final PPTX QA
pass. Provide the printed `PREVIEW_IMAGE_PATH` to the configured artifact
publisher; do not reuse preview images from earlier renders.

Do not run `which`, `file`, `identify`, repeated `ls`, or other environment
probes on the happy path. If a concrete phase fails, inspect that failure and
repair only that class of problem. `file` is optional diagnostic only; if needed,
make it non-blocking and feed it the discovered paths from
`$QA_DIR/slide-images.txt` instead of any fixed QA directory or filename pattern.

## Layout Dimensions

Slide dimensions (coordinates in inches):
- `LAYOUT_16x9`: 10" x 5.625" (default)
- `LAYOUT_16x10`: 10" x 6.25"
- `LAYOUT_4x3`: 10" x 7.5"
- `LAYOUT_WIDE`: 13.3" x 7.5"

**Layout names are case-sensitive.** Use `LAYOUT_16x9`, not `LAYOUT_16X9`.
`LAYOUT_16X9` causes `UNKNOWN-LAYOUT` in PptxGenJS.

---

## Text & Formatting

### JS Literal Safety

Most generation failures come from natural-language text breaking JavaScript
syntax before PptxGenJS runs. Keep long text in `DATA` constants and reference
it through `txt(DATA.key)`.

```javascript
// Correct: user-facing quotes are Chinese curly quotes inside a template string
const DATA = {
  title: `为什么“讲出来”能让你真正学会`,
  loop: `形成一个“简化 -> 复述 -> 纠错”的循环，知识才会真正留下。`,
  event: `挑战者号事故调查中的“O环”演示`,
};

slide.addText(txt(DATA.title), titleOpts);
slide.addText(txt(DATA.loop), bodyOpts);

// Wrong: nested straight quotes break JavaScript
slide.addText("为什么"讲出来"能让你真正学会", titleOpts);
slide.addText("挑战者号事故调查中的"O环"演示", bodyOpts);
```

Rules:

- Do not scatter long Chinese/user-provided strings inside drawing calls.
- Prefer template strings for authored deck text and visible curly quotes for
  quoted words.
- Use `JSON.stringify(value)` only when converting external/untrusted text into
  source code during repair or preprocessing. Do not paste template expressions
  like `${JSON.stringify(...)}` literally into `deck.js`.
- If `node --check` fails near Chinese text, quoted words, or examples, fix the
  string boundary before changing slide design.

### Safe `addText` Patterns

`slide.addText` accepts either a plain string or a rich text array. Do not pass a
single object as the first argument, and do not mix raw strings inside rich text
arrays.

```javascript
const rich = (items) =>
  items.map((item) => ({ text: txt(item.text), options: item.options ?? {} }));

// Correct: plain string
slide.addText("✓", { x: 1, y: 1, w: 0.3, h: 0.3, fontSize: 14 });

// Correct: plain natural-language string from DATA
slide.addText(txt(DATA.title), { x: 1, y: 1, w: 6, h: 0.5 });

// Correct: rich text array
slide.addText(rich([
  { text: "Key idea: ", options: { bold: true } },
  { text: "explain it simply" },
]), { x: 1, y: 1.5, w: 4, h: 0.4 });

// Wrong: object as first argument
slide.addText({ text: "Key idea" }, { x: 1, y: 1, w: 4, h: 0.4 });

// Wrong: raw string mixed into rich text array
slide.addText(["✓", { text: "Done" }], { x: 1, y: 1, w: 4, h: 0.4 });
```

For checkmarks, bullets, numbers, badges, or icons, prefer a separate
`slide.addText("✓", opts)`, native shape, or raster icon. Do not mix symbols as
raw array items in rich text.

```javascript
// Basic text
slide.addText("Simple Text", {
  x: 1, y: 1, w: 8, h: 2, fontSize: 24, fontFace: "Arial",
  color: "363636", bold: true, align: "center", valign: "middle"
});

// Character spacing (use charSpacing, not letterSpacing which is silently ignored)
slide.addText("SPACED TEXT", { x: 1, y: 1, w: 8, h: 1, charSpacing: 6 });

// Rich text arrays
slide.addText([
  { text: "Bold ", options: { bold: true } },
  { text: "Italic ", options: { italic: true } }
], { x: 1, y: 3, w: 8, h: 1 });

// Multi-line text (requires breakLine: true)
slide.addText([
  { text: "Line 1", options: { breakLine: true } },
  { text: "Line 2", options: { breakLine: true } },
  { text: "Line 3" }  // Last item doesn't need breakLine
], { x: 0.5, y: 0.5, w: 8, h: 2 });

// Text box margin (internal padding)
slide.addText("Title", {
  x: 0.5, y: 0.3, w: 9, h: 0.6,
  margin: 0  // Use 0 when aligning text with other elements like shapes or icons
});
```

**Tip:** Text boxes have internal margin by default. Set `margin: 0` when you need text to align precisely with shapes, lines, or icons at the same x-position.

---

## Lists & Bullets

```javascript
// CORRECT: Multiple bullets
slide.addText([
  { text: "First item", options: { bullet: true, breakLine: true } },
  { text: "Second item", options: { bullet: true, breakLine: true } },
  { text: "Third item", options: { bullet: true } }
], { x: 0.5, y: 0.5, w: 8, h: 3 });

// WRONG: Never use unicode bullets
slide.addText("* First item", { ... });  // Creates double bullets

// Sub-items and numbered lists
{ text: "Sub-item", options: { bullet: true, indentLevel: 1 } }
{ text: "First", options: { bullet: { type: "number" }, breakLine: true } }
```

---

## Shapes

```javascript
slide.addShape(pres.shapes.RECTANGLE, {
  x: 0.5, y: 0.8, w: 1.5, h: 3.0,
  fill: { color: "FF0000" }, line: { color: "000000", width: 2 }
});

slide.addShape(pres.shapes.OVAL, { x: 4, y: 1, w: 2, h: 2, fill: { color: "0000FF" } });

slide.addShape(pres.shapes.LINE, {
  x: 1, y: 3, w: 5, h: 0, line: { color: "FF0000", width: 3, dashType: "dash" }
});

// With transparency
slide.addShape(pres.shapes.RECTANGLE, {
  x: 1, y: 1, w: 3, h: 2,
  fill: { color: "0088CC", transparency: 50 }
});

// Rounded rectangle (rectRadius only works with ROUNDED_RECTANGLE, not RECTANGLE)
// Don't pair with rectangular accent overlays -- they won't cover rounded corners. Use RECTANGLE instead.
slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
  x: 1, y: 1, w: 3, h: 2,
  fill: { color: "FFFFFF" }, rectRadius: 0.1
});

// With shadow
slide.addShape(pres.shapes.RECTANGLE, {
  x: 1, y: 1, w: 3, h: 2,
  fill: { color: "FFFFFF" },
  shadow: { type: "outer", color: "000000", blur: 6, offset: 2, angle: 135, opacity: 0.15 }
});
```

Shadow options:

| Property | Type | Range | Notes |
|----------|------|-------|-------|
| `type` | string | `"outer"`, `"inner"` | |
| `color` | string | 6-char hex (e.g. `"000000"`) | No `#` prefix, no 8-char hex -- see Common Pitfalls |
| `blur` | number | 0-100 pt | |
| `offset` | number | 0-200 pt | **Must be non-negative** -- negative values corrupt the file |
| `angle` | number | 0-359 degrees | Direction the shadow falls (135 = bottom-right, 270 = upward) |
| `opacity` | number | 0.0-1.0 | Use this for transparency, never encode in color string |

To cast a shadow upward (e.g. on a footer bar), use `angle: 270` with a positive offset -- do **not** use a negative offset.

**Note**: Gradient fills are not natively supported. Use a gradient image as a background instead.

---

## Images

### Image Sources

```javascript
// From file path
slide.addImage({ path: "images/chart.png", x: 1, y: 1, w: 5, h: 3 });

// From URL
slide.addImage({ path: "https://example.com/image.jpg", x: 1, y: 1, w: 5, h: 3 });

// From base64 (faster, no file I/O)
slide.addImage({ data: "image/png;base64,iVBORw0KGgo...", x: 1, y: 1, w: 5, h: 3 });
```

### Image Options

```javascript
slide.addImage({
  path: "image.png",
  x: 1, y: 1, w: 5, h: 3,
  rotate: 45,              // 0-359 degrees
  rounding: true,          // Circular crop
  transparency: 50,        // 0-100
  flipH: true,             // Horizontal flip
  flipV: false,            // Vertical flip
  altText: "Description",  // Accessibility
  hyperlink: { url: "https://example.com" }
});
```

### Image Sizing Modes

```javascript
// Contain - fit inside, preserve ratio
{ sizing: { type: 'contain', w: 4, h: 3 } }

// Cover - fill area, preserve ratio (may crop)
{ sizing: { type: 'cover', w: 4, h: 3 } }

// Crop - cut specific portion
{ sizing: { type: 'crop', x: 0.5, y: 0.5, w: 2, h: 2 } }
```

### Calculate Dimensions (preserve aspect ratio)

```javascript
const origWidth = 1978, origHeight = 923, maxHeight = 3.0;
const calcWidth = maxHeight * (origWidth / origHeight);
const centerX = (10 - calcWidth) / 2;

slide.addImage({ path: "image.png", x: centerX, y: 1.2, w: calcWidth, h: maxHeight });
```

### Supported Formats

- **Standard**: PNG, JPG, GIF (animated GIFs work in Microsoft 365)
- **SVG**: Works in modern PowerPoint/Microsoft 365

---

## Icons

Use react-icons to generate SVG icons, then rasterize to PNG for universal compatibility.

### Setup

```javascript
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const sharp = require("sharp");
const { FaCheckCircle, FaChartLine } = require("react-icons/fa");

function renderIconSvg(IconComponent, color = "#000000", size = 256) {
  return ReactDOMServer.renderToStaticMarkup(
    React.createElement(IconComponent, { color, size: String(size) })
  );
}

async function iconToBase64Png(IconComponent, color, size = 256) {
  const svg = renderIconSvg(IconComponent, color, size);
  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return "image/png;base64," + pngBuffer.toString("base64");
}
```

### Add Icon to Slide

```javascript
const iconData = await iconToBase64Png(FaCheckCircle, "#4472C4", 256);

slide.addImage({
  data: iconData,
  x: 1, y: 1, w: 0.5, h: 0.5  // Size in inches
});
```

**Note**: Use size 256 or higher for crisp icons. The size parameter controls the rasterization resolution, not the display size on the slide (which is set by `w` and `h` in inches).

### Icon Libraries

Install: `npm install -g react-icons react react-dom sharp`

Popular icon sets in react-icons:
- `react-icons/fa` - Font Awesome
- `react-icons/md` - Material Design
- `react-icons/hi` - Heroicons
- `react-icons/bi` - Bootstrap Icons

---

## Slide Backgrounds

```javascript
// Solid color
slide.background = { color: "F1F1F1" };

// Color with transparency
slide.background = { color: "FF3399", transparency: 50 };

// Image from URL
slide.background = { path: "https://example.com/bg.jpg" };

// Image from base64
slide.background = { data: "image/png;base64,iVBORw0KGgo..." };
```

---

## Tables

```javascript
slide.addTable([
  ["Header 1", "Header 2"],
  ["Cell 1", "Cell 2"]
], {
  x: 1, y: 1, w: 8, h: 2,
  border: { pt: 1, color: "999999" }, fill: { color: "F1F1F1" }
});

// Advanced with merged cells
let tableData = [
  [{ text: "Header", options: { fill: { color: "6699CC" }, color: "FFFFFF", bold: true } }, "Cell"],
  [{ text: "Merged", options: { colspan: 2 } }]
];
slide.addTable(tableData, { x: 1, y: 3.5, w: 8, colW: [4, 4] });
```

---

## Charts

```javascript
// Bar chart
slide.addChart(pres.charts.BAR, [{
  name: "Sales", labels: ["Q1", "Q2", "Q3", "Q4"], values: [4500, 5500, 6200, 7100]
}], {
  x: 0.5, y: 0.6, w: 6, h: 3, barDir: 'col',
  showTitle: true, title: 'Quarterly Sales'
});

// Line chart
slide.addChart(pres.charts.LINE, [{
  name: "Temp", labels: ["Jan", "Feb", "Mar"], values: [32, 35, 42]
}], { x: 0.5, y: 4, w: 6, h: 3, lineSize: 3, lineSmooth: true });

// Pie chart
slide.addChart(pres.charts.PIE, [{
  name: "Share", labels: ["A", "B", "Other"], values: [35, 45, 20]
}], { x: 7, y: 1, w: 5, h: 4, showPercent: true });
```

### Better-Looking Charts

Default charts look dated. Apply these options for a modern, clean appearance:

```javascript
slide.addChart(pres.charts.BAR, chartData, {
  x: 0.5, y: 1, w: 9, h: 4, barDir: "col",

  // Custom colors (match your presentation palette)
  chartColors: ["0D9488", "14B8A6", "5EEAD4"],

  // Clean background
  chartArea: { fill: { color: "FFFFFF" }, roundedCorners: true },

  // Muted axis labels
  catAxisLabelColor: "64748B",
  valAxisLabelColor: "64748B",

  // Subtle grid (value axis only)
  valGridLine: { color: "E2E8F0", size: 0.5 },
  catGridLine: { style: "none" },

  // Data labels on bars
  showValue: true,
  dataLabelPosition: "outEnd",
  dataLabelColor: "1E293B",

  // Hide legend for single series
  showLegend: false,
});
```

**Key styling options:**
- `chartColors: [...]` - hex colors for series/segments
- `chartArea: { fill, border, roundedCorners }` - chart background
- `catGridLine/valGridLine: { color, style, size }` - grid lines (`style: "none"` to hide)
- `lineSmooth: true` - curved lines (line charts)
- `legendPos: "r"` - legend position: "b", "t", "l", "r", "tr"

---

## Slide Masters

```javascript
pres.defineSlideMaster({
  title: 'TITLE_SLIDE', background: { color: '283A5E' },
  objects: [{
    placeholder: { options: { name: 'title', type: 'title', x: 1, y: 2, w: 8, h: 2 } }
  }]
});

let titleSlide = pres.addSlide({ masterName: "TITLE_SLIDE" });
titleSlide.addText("My Title", { placeholder: "title" });
```

---

## Common Pitfalls

These issues cause file corruption, visual bugs, or broken output. Avoid them.

0. **Use exact layout names** - layout names are case-sensitive.
   ```javascript
   pres.layout = "LAYOUT_16x9"; // CORRECT
   pres.layout = "LAYOUT_16X9"; // WRONG: UNKNOWN-LAYOUT
   ```

0.1. **Keep deck text in DATA** - long Chinese/user text and quoted text should
   not be inline inside `addText` calls.
   ```javascript
   const DATA = { title: `为什么“讲出来”能让你真正学会` };
   slide.addText(txt(DATA.title), opts); // CORRECT
   slide.addText("为什么"讲出来"能让你真正学会", opts); // SYNTAX ERROR
   ```

1. **NEVER use "#" with hex colors** - causes file corruption
   ```javascript
   color: "FF0000"      // CORRECT
   color: "#FF0000"     // WRONG
   ```

2. **NEVER encode opacity in hex color strings** - 8-char colors (e.g., `"00000020"`) corrupt the file. Use the `opacity` property instead.
   ```javascript
   shadow: { type: "outer", blur: 6, offset: 2, color: "00000020" }          // CORRUPTS FILE
   shadow: { type: "outer", blur: 6, offset: 2, color: "000000", opacity: 0.12 }  // CORRECT
   ```

3. **Use `bullet: true`** - NEVER unicode symbols like "o" (creates double bullets)

4. **Use `breakLine: true`** between array items or text runs together

5. **Avoid `lineSpacing` with bullets** - causes excessive gaps; use `paraSpaceAfter` instead

6. **Each presentation needs fresh instance** - don't reuse `pptxgen()` objects

7. **NEVER reuse option objects across calls** - PptxGenJS mutates objects in-place (e.g. converting shadow values to EMU). Sharing one object between multiple calls corrupts the second shape.
   ```javascript
   const shadow = { type: "outer", blur: 6, offset: 2, color: "000000", opacity: 0.15 };
   slide.addShape(pres.shapes.RECTANGLE, { shadow, ... });  // second call gets already-converted values
   slide.addShape(pres.shapes.RECTANGLE, { shadow, ... });

   const makeShadow = () => ({ type: "outer", blur: 6, offset: 2, color: "000000", opacity: 0.15 });
   slide.addShape(pres.shapes.RECTANGLE, { shadow: makeShadow(), ... });  // fresh object each time
   slide.addShape(pres.shapes.RECTANGLE, { shadow: makeShadow(), ... });
   ```

8. **Don't use `ROUNDED_RECTANGLE` with accent borders** - rectangular overlay bars won't cover rounded corners. Use `RECTANGLE` instead.
   ```javascript
   // WRONG: Accent bar doesn't cover rounded corners
   slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 1, y: 1, w: 3, h: 1.5, fill: { color: "FFFFFF" } });
   slide.addShape(pres.shapes.RECTANGLE, { x: 1, y: 1, w: 0.08, h: 1.5, fill: { color: "0891B2" } });

   // CORRECT: Use RECTANGLE for clean alignment
   slide.addShape(pres.shapes.RECTANGLE, { x: 1, y: 1, w: 3, h: 1.5, fill: { color: "FFFFFF" } });
   slide.addShape(pres.shapes.RECTANGLE, { x: 1, y: 1, w: 0.08, h: 1.5, fill: { color: "0891B2" } });
   ```

---

## Quick Reference

- **Shapes**: RECTANGLE, OVAL, LINE, ROUNDED_RECTANGLE
- **Charts**: BAR, LINE, PIE, DOUGHNUT, SCATTER, BUBBLE, RADAR
- **Layouts**: LAYOUT_16x9 (10"x5.625"), LAYOUT_16x10, LAYOUT_4x3, LAYOUT_WIDE
- **Text**: `addText(string, opts)` or `addText([{ text, options? }], opts)` only
- **Alignment**: "left", "center", "right"
- **Chart data labels**: "outEnd", "inEnd", "center"
