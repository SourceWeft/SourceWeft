# Background Recipes

Use this when backgrounds, large visual fields, theme textures, or image panels
matter. Backgrounds are part of the message; they should make slides feel
designed without reducing readability.

## Rules

- Every storyboard item needs a `backgroundTreatment`.
- Plain white is acceptable only when the foreground composition is strong and
  not a title-and-bullet page.
- Do not use title underlines as a substitute for background design.
- PptxGenJS does not support native gradient fills. Use solid fields, layered
  translucent shapes, SVG/PNG backgrounds, or images.
- Use 6-character hex colors without `#`; use `transparency` or `opacity`
  fields rather than 8-character hex colors.
- Put backgrounds behind content and keep contrast high.

## Recipes

### Dark Field

Use for covers, closings, premium tech, executive summaries, major insights.

- Fill the slide with a dark dominant color.
- Add one large motif: oversized number, network, chalk loop, product silhouette,
  chart line, or abstract field.
- Keep text in one clear zone with high contrast.
- Good presets: Executive Strategy, Premium Dark Tech, Learning Studio.

### Split Color Field

Use for comparisons, problem/solution, before/after, agendas, strategy choices.

- Divide slide into two or three large color fields.
- Encode meaning through color contrast.
- Align columns exactly; keep text budgets balanced.
- Avoid tiny side bars or underlines as the only color move.

### Canvas Surface

Use for dashboards, frameworks, matrices, scorecards, and data views.

- Start with a soft reading background.
- Add one large surface/panel for the main structure.
- Use subtle borders, internal dividers, and stable grid geometry.
- Keep shadows subtle and fresh per shape call.

### Diagram Field

Use for processes, architecture, concept maps, pipelines, and timelines.

- Let the whole slide become diagram space.
- Use nodes, bands, arrows, connectors, stages, or regions as the composition.
- Keep labels short and prevent connectors from crossing text.
- Good for turning bullets into a real visual explanation.

### Topic Texture

Use for education, academic, craft, history, wellness, and technical contexts.

- Create a subtle repeatable motif with native shapes or procedural SVG/PNG.
- Examples: notebook lines, blackboard grain, citation margin, blueprint grid,
  constellation dots, graph nodes, contour lines.
- Texture should stay low contrast and must not compete with text.

### Half-Bleed Visual

Use for screenshots, examples, product moments, photos, teaching scenarios.

- Reserve 35-55% of the slide for the visual.
- Align the visual to the slide edge for a decisive composition.
- Put text in structured callouts on the opposite side or overlay with a solid
  translucent panel.
- If no reliable asset exists, use a procedural illustration or wireframe.

### Full-Bleed Visual With Overlay

Use for cover, divider, closing, strong story/case moments.

- Fill the full slide with a photo, generated raster, procedural image, or
  large illustration.
- Add a dark or light overlay panel for text readability.
- Keep visible text minimal.
- Do not crop away the actual subject.

### Insight Strip

Use for data reports and executive decks.

- Create a strong horizontal or vertical band containing the main number,
  conclusion, or status.
- Pair with a chart or 2-3 supporting callouts.
- Keep the strip visually dominant, not a footer decoration.

## Preset Pairings

| Preset | Strong backgrounds |
| --- | --- |
| Learning Studio | blackboard dark field, notebook texture, sticky-note split field, diagram field |
| Executive Strategy | navy/charcoal dark field, canvas dashboard, gold insight strip, split decision field |
| Product Launch | hero product surface, half-bleed screenshot, modular canvas, coral spotlight field |
| Data Report | canvas surface, dark insight slide, benchmark strip, chart field |
| Academic Explainer | cream note surface, annotated diagram field, evidence-board split, dark divider |
| Premium Dark Tech | dark network field, pipeline diagram field, model-card canvas, amber insight strip |

## Implementation Notes

- Use `slide.background = { color: "..." }` for simple solid backgrounds.
- For layered backgrounds, add full-slide shapes before content.
- For procedural textures, create SVG strings and convert with `sharp` when PNG
  is safer than direct SVG insertion.
- For full-bleed image backgrounds, use `sizing: { type: "cover", w, h }` or
  crop intentionally.
- Do not make text readable by adding a tiny text box over a busy image; use a
  real overlay field.
