# QA Process & Common Pitfalls

## QA Process

**Assume there are problems. Your job is to find them.**

Your first render is almost never correct. Approach QA as a bug hunt, not a confirmation step. If you found zero issues on first inspection, you weren't looking hard enough.

### Content QA

```bash
python3 -m markitdown <actual-generated-pptx-path>
```

Check for missing content, typos, wrong order. Always use the actual sandbox path printed by the deck program.

**Check for leftover placeholder text:**

```bash
python3 -m markitdown <actual-generated-pptx-path> | grep -iE "xxxx|lorem|ipsum|placeholder|this.*(page|slide).*layout"
```

If grep returns results, fix them before declaring success.

### Visual QA

Render the actual PPTX before publishing. Text extraction cannot catch overlaps, clipped boxes, poor contrast, or monotonous layouts.

```bash
PPTX_ARTIFACT_PATH="<actual-generated-pptx-path>"
QA_DIR="/workspace/ppt-deck/qa"
mkdir -p "$QA_DIR"
soffice --headless --convert-to pdf --outdir "$QA_DIR" "$PPTX_ARTIFACT_PATH"
pdftoppm -jpeg -r 150 "$QA_DIR/<deck-slug>.pdf" "$QA_DIR/slide"
```

Inspect the generated slide JPG files or a `contact-sheet.jpg`. Look for:

- overlapping elements
- text cut off at box edges
- low-contrast text, icons, or chart labels
- pure text slides
- three or more repeated layout classes in a row
- cramped content or large accidental empty zones
- leftover placeholder content

Fix visible issues before calling `publish_sandbox_artifact`.

### Verification Loop

1. Run the deck program -> Extract text from the actual generated PPTX path -> Render slide images -> Review content and visuals
2. **List issues found** (if none found, look again more critically)
3. Fix `/workfiles/ppt-deck/deck.js`, then prepare it to `/workspace/ppt-deck/deck.js`
4. **Re-verify affected slides** — one fix often creates another problem
5. Repeat until a full pass reveals no new issues

**Do not declare success until you've completed at least one fix-and-verify cycle.**

### Optional Isolated Slide QA

For unusually large or tricky decks, you may temporarily render one problem slide from the same helper/layout code. Keep this as a debugging aid only; the default from-scratch workflow remains one full `deck.js` program and QA against the generated presentation.

---

## Common Mistakes to Avoid

- **Don't repeat the same layout** — vary columns, cards, and callouts across slides
- **Don't center body text** — left-align paragraphs and lists; center only titles
- **Don't skimp on size contrast** — titles need 36pt+ to stand out from 14-16pt body
- **Don't default to blue** — pick colors that reflect the specific topic
- **Don't mix spacing randomly** — choose 0.3" or 0.5" gaps and use consistently
- **Don't style one slide and leave the rest plain** — commit fully or keep it simple throughout
- **Don't create text-only slides** — add images, icons, charts, or visual elements; avoid plain title + bullets
- **Don't forget text box padding** — when aligning lines or shapes with text edges, set `margin: 0` on the text box or offset the shape to account for padding
- **Don't use low-contrast elements** — icons AND text need strong contrast against the background
- **NEVER use accent lines under titles** — these are a hallmark of AI-generated slides; use whitespace or background color instead
- **NEVER use "#" with hex colors** — causes file corruption in PptxGenJS
- **NEVER encode opacity in hex strings** — use the `opacity` property instead
- **Always await asynchronous PPTX writes** — `writeFile` returns a promise; call it from `main()` and handle failures
- **NEVER reuse option objects across PptxGenJS calls** — PptxGenJS mutates objects in-place

---

## Critical Pitfalls — PptxGenJS

### Always await PPTX writes

```javascript
// WRONG - process can exit before the file is complete
pres.writeFile({ fileName: PPTX_PATH });

// CORRECT
async function main() {
  await pres.writeFile({ fileName: PPTX_PATH });
}
```

### NEVER use "#" with hex colors

```javascript
color: "FF0000"; // CORRECT
color: "#FF0000"; // CORRUPTS FILE
```

### NEVER encode opacity in hex strings

```javascript
shadow: { color: "00000020" }              // CORRUPTS FILE
shadow: { color: "000000", opacity: 0.12 } // CORRECT
```

### Prevent text wrapping in titles

```javascript
// Use fit:'shrink' for long titles
slide.addText("Long Title Here", {
  x: 0.5,
  y: 2,
  w: 9,
  h: 1,
  fontSize: 48,
  fit: "shrink",
});
```

### NEVER reuse option objects across calls

```javascript
// WRONG
const shadow = { type: "outer", blur: 6, offset: 2, color: "000000", opacity: 0.15 };
slide.addShape(pres.shapes.RECTANGLE, { shadow, ... });
slide.addShape(pres.shapes.RECTANGLE, { shadow, ... });

// CORRECT - factory function
const makeShadow = () => ({ type: "outer", blur: 6, offset: 2, color: "000000", opacity: 0.15 });
slide.addShape(pres.shapes.RECTANGLE, { shadow: makeShadow(), ... });
slide.addShape(pres.shapes.RECTANGLE, { shadow: makeShadow(), ... });
```
