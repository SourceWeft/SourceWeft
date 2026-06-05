---
name: ppt-deck
description: Use this skill to create presentation artifacts with a clear claim spine, proof objects, visual asset discipline, and QA before delivery.
argument-hint: "[deck topic, audience, sources, or desired slide count]"
user-invocable: true
disable-model-invocation: false
---

# PPT Deck

Use this skill when the user wants a PowerPoint, PPTX, slide deck, pitch deck,
presentation, training deck, board deck, report deck, or editable slides.

## Hard Rules

1. Deliver a persisted native editable PPTX artifact by calling `generate_pptx`.
   SourceWeft uses the composer/high-quality PPTX route by default.
2. Start with a claim spine: each slide gets one concise claim.
3. Give each non-title slide a proof object: chart, table, process, screenshot,
   image, quote, comparison, source-backed number, or action list.
4. Do not make a deck that is only bullet lists unless the user explicitly asks
   for a rough outline.
5. Use `generate_image` before `generate_pptx` only when a new visual asset is
   necessary. Pass generated image artifact ids into `generate_pptx`.
6. Do not invent logos, brand marks, people, product UI, official screenshots,
   or reported metrics. Use user-provided or verified assets, or omit them.
7. Check the `generate_pptx` QA summary and warnings. For final-quality work,
   fix blocking warnings before presenting the artifact.
8. The renderer is not a copywriter. Every visible title, subtitle, kicker,
   caption, footer, table row, chart value, quote, and body line must be
   intentionally supplied in the tool arguments.
9. For editable PowerPoint output, object structure is part of quality. Do not
   create blank cards, empty media frames, unused placeholders, or duplicate
   layout boxes that are not consumed by visible slide content.

## Workflow

1. Classify the task: `create`, `edit`, `analyze`, template-following, or
   source-to-deck. Use `create` unless an existing deck/template is supplied.
2. Identify audience, goal, desired length, language, and any required source
   material from the conversation and selected files.
3. Draft a DeckSpec-style plan before calling the tool: narrative arc, slide
   mix, each slide's intent, visible content slots, and design system. Do not
   reuse a fixed slide sequence unless the user asks for a standard template.
4. Choose a design preset:
   - `executive` for strategy, operating, board, investor, and client decks.
   - `technical` for architecture, engineering, AI, data, and workflow decks.
   - `editorial` for image-led, brand, lifestyle, or narrative decks.
   - `data-heavy` for appendices, financials, tables, and KPI reporting.
5. Set `design.aspectRatio`, `design.language`, and `design.stylePreset`
   explicitly when the user or task implies them.
   For `custom`, write `design.customBrief` and `design.visualSystem` so the
   model controls the generated style instead of relying on a coded theme.
   Treat `custom` as style intent, not layout permission: map mood, palette,
   density, typography, and tone into registered safe layouts only. Do not
   invent arbitrary geometry, empty cards, decorative shape systems, or
   longform/card hybrids.
   Prefer the v2 visual-system fields when the visual direction is specific:
   `styleFamily` (`swiss`, `magazine`, `education`, `blueprint`,
   `data-report`, or `editorial`), `density`, `geometry`, `chrome`,
   `illustration`, and `layoutPolicy`. Do not put raw CSS or HTML in these
   fields; describe the intent as design tokens and registered layout
   preferences.
   For education, teaching, study, classroom, course, training, or Feynman
   decks, set or allow `styleFamily: "education"` by default. Only use
   `magazine` or `editorial` for education content when the user explicitly
   requests that treatment.
   Legacy `generationMode` values may appear in older requests. Accept them
   only for backward compatibility; the tool normalizes them internally to the
   native editable PPTX route.
6. Favor clean PowerPoint-native text boxes, shapes, tables, and charts. Each
   object should be editable and intentional; avoid decorative card systems made
   from empty shapes plus separate text.
7. Call `generate_pptx` with explicit `content.cover` fields and per-slide
   `title`, `kicker`, `caption`, `footer`, `body`, and `notes` when those
   elements should be visible.
8. If warnings mention missing images, long text, or template limitations,
   either revise the slide specs and retry or clearly state the residual
   limitation.

## Native Editable PPTX Contract

Use this contract for every PPTX deck:

- Plan content slots before calling the tool: title/claim, proof object,
  optional caption/footer, and only the body slots that will actually be shown.
- Prefer one editable object that carries both styling and text over a blank
  decorative object paired with a separate text object.
- Use native chart/table/comparison objects for proof, not screenshot-like
  placeholder panels.
- If an image slide has no real image asset, change the slide kind or omit the
  image frame instead of leaving an empty image placeholder.
- Treat `editable_native_empty_shape`,
  `editable_native_repeated_empty_geometry`, and
  `editable_native_empty_placeholder` warnings as blocking for final-quality
  work unless explicitly disclosed as a draft limitation.
- Do not pass a template-like layout as a canvas and overlay new elements on
  top of inherited empty placeholders. Fill or delete inherited placeholders
  intentionally.

## Visual Direction

- Treat the presets as internal design directions, not templates to copy from
  any external skill or repository.
- Do not put tool configuration or file traits in visible slide text. Values
  like `generationMode`, `stylePreset`, `customBrief`, template ids, aspect
  ratio, file format labels, and preset names may guide layout and styling,
  but visible titles, subtitles, eyebrow text, headers, footers, captions,
  placeholders, and body copy must be supplied as content slots unless the user
  explicitly wrote those words as content.
- If a template is supplied, treat it as `visual_reference` or
  `layout_reference` in v1. Generate fresh cover title/subtitle and slide copy;
  do not preserve sample text, placeholder text, source labels, or template
  default titles.
- Favor clear hierarchy, generous margins, readable tables, and strong slide
  claims over decorative complexity.
- For custom PPTX decks, choose a coherent style family:
  - `education` for teaching, learning methods, warm classroom systems, steps,
    examples, exercises, and summaries.
  - `swiss` for strict grid, single-accent, sharp, product/data/engineering
    decks.
  - `magazine` or `editorial` for narrative, quote, image-led, and publication
    rhythm.
  - `blueprint` for architecture, system maps, process, and technical diagrams.
  - `data-report` for KPI, table, chart, and appendix-heavy decks.
- For `data-heavy`, use tables/charts as the proof object and keep prose short.
- For `editorial`, alternate text-led and image/quote-led moments.
- For `technical`, prefer systems, steps, interfaces, architecture, and
  comparison layouts.
- Do not map 3-6 bullet card content into longform layouts. Use card/grid
  layouts for short lists, paragraph layouts for one long explanation, and
  step-board layouts for 2-4 ordered method/process bullets.

## Slide Spec Guidance

- `title`: deck title and framing subtitle.
- `section`: chapter divider with a short thesis.
- `content`: one claim plus 3-5 concise support points.
- `comparison`: side-by-side tradeoffs, before/after, options, or competitors.
- `chart`: simple numeric data with labels and values.
- `table`: dense facts that need exact rows and columns.
- `image`: one visual asset with caption or inspection context.
- `quote`: customer voice, executive quote, or source excerpt.
- `closing`: decisions, recommendations, timeline, or next steps.

## QA Gate

A deck is ready only when:

- The slides artifact exists.
- Every slide has a clear claim.
- The first slide makes the topic obvious.
- No slide depends on an uncreated image asset.
- No slide contains empty render blocks, single-card grid holes, cards mapped
  into longform, repeated macro layouts, unrequested cover decoration, or
  language-polluted visible copy.
- Long text warnings are resolved or acknowledged as draft-quality.
- Template/edit limitations are disclosed when relevant.
