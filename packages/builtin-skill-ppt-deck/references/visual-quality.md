# Visual Quality Scorecard

Use this when a from-scratch deck still looks weak, when doing a visual
redesign, or when you need a stricter review before publishing. This is a QA
scorecard, not a replacement for the Design Brief and Storyboard in `SKILL.md`.

## Scorecard

Score each item from 0-2. A polished deck should usually score 12+ out of 16.
Any item scored 0 needs a fix before publishing.

| Dimension | 0 | 1 | 2 |
| --- | --- | --- | --- |
| Topic-specific theme | Generic colors/motif | Palette fits topic but motif is weak | Preset/motif clearly belongs to this topic |
| Visual hierarchy | Everything similar size | Some hierarchy | Clear focal point on every slide |
| Primary visuals | Text-only or tiny icons | Some useful visuals | Every content slide has a meaningful visual |
| Background treatment | Plain/accidental | Some intentional surfaces | Strong rhythm with dark/light and visual fields |
| Layout variety | Repeated cards/bullets | Some variation | 3+ layout families, no monotony |
| Text compression | Paragraph-heavy | Mixed text and labels | Mostly labels, captions, callouts, diagrams |
| Craft and spacing | Overlap/crowding/low contrast | Minor concerns | Clean margins, alignment, contrast |
| Deck coherence | Slides feel unrelated | Shared colors only | Motif, palette, and typography unify the deck |

## Hard Failures

Fix before publishing:

- A content slide is only title + bullets.
- A small icon, page number, or accent mark is the only visual.
- Three consecutive slides use the same layout key.
- Cover or closing looks like an ordinary content slide.
- A slide promises an image, chart, screenshot, blackboard, notebook, logo, or
  diagram that is not visible in the render.
- Text overlaps, clips, collides with footers, or falls below readable contrast.
- Decorative title underlines, color bars, sidebar stripes, or card edge stripes
  are used as the main visual system.
- The deck defaults to cream/beige backgrounds without an intentional theme
  preset that calls for those surfaces.
- Body text defaults to Aptos or another QA-unreliable font without user request.
- The rendered contact sheet looks like a document rather than a presentation.
- File QA (`validate_pptx.py`) reports package or chart structure errors.

## Visual Thresholds

For a normal 16:9 deck:

- Content slides should dedicate about 25-60% of slide area to the primary
  visual or visual structure.
- Cover, divider, and closing slides should be visual moments.
- For every 10 slides, target at least:
  - 4 slides with image, screenshot, illustration, generated/procedural asset,
    or large background field
  - 3 slides with diagrammatic structure such as process, timeline, comparison,
    framework canvas, concept map, or data view
  - 1 memorable visual moment beyond the cover

Scale counts proportionally for shorter or longer decks.

## Fresh Fix Moves

When a slide looks like a document page:

- Convert bullet sequence into a process ribbon, loop, ladder, or timeline.
- Convert contrast into a split comparison or misconception/fix slide.
- Convert categories into a 2x2 canvas, matrix, or map.
- Convert abstract explanation into a concept map with 3-6 nodes.
- Convert a paragraph into a large principle plus 2-3 supporting labels.
- Add a decisive visual field: half-bleed image, dark side panel, diagram
  background, notebook texture, or large shape illustration.
- Split one dense slide into two simpler slides.

## Contact Sheet Review

After rendering, inspect slides together as a contact sheet:

- Is there a clear cover-to-closing visual rhythm?
- Can the audience identify the deck's topic from visuals alone?
- Do neighboring slides vary layout while sharing the same motif?
- Are there any plain, empty, cramped, or overly similar slides?
- Do the strongest visual moments land at opening, transitions, key insights,
  and closing?

If the answer is no, revise the storyboard and regenerate rather than polishing
individual text boxes.

## Optional QA Ledger

For large or tricky decks, `deck.js` may maintain an optional ledger:

```javascript
const slideMetadata = [];

function recordSlide(meta) {
  slideMetadata.push({
    slideNumber: slideMetadata.length + 1,
    slideType: meta.slideType,
    layoutKey: meta.layoutKey,
    backgroundType: meta.backgroundType,
    primaryVisualType: meta.primaryVisualType,
    visualAreaPct: meta.visualAreaPct,
    textCharCount: meta.textCharCount,
    assetCount: meta.assetCount,
  });
}
```

Print it only as supporting QA evidence:

```javascript
console.log(`SLIDE_METADATA_JSON=${JSON.stringify(slideMetadata)}`);
```

Do not let metadata replace rendered visual inspection.
