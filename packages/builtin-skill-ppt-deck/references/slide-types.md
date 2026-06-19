# Slide Types

Use this file to build the required storyboard before coding a from-scratch
deck. Every slide needs exactly one `slideType`, one `layoutPattern`, one
`primaryVisual`, one `backgroundTreatment`, and one `textBudget`.

Plain title-and-bullet slides are not a default slide type. Convert bullet
content into process, comparison, concept map, framework canvas, data insight,
case/example, recap matrix, or mixed media.

## Storyboard Fields

| Field | Meaning |
| --- | --- |
| `slideType` | Cover, Agenda, Divider, Process, Comparison, Concept Map, Framework Canvas, Data Insight, Mixed Media, Case/Example, Recap Matrix, Principle Poster, Closing |
| `layoutPattern` | A concrete layout key such as `hero-left-visual-right`, `process-loop`, `split-comparison`, `canvas-2x2` |
| `primaryVisual` | The main non-text visual or structure; small icons/page numbers do not count |
| `backgroundTreatment` | Solid field, split field, canvas surface, diagram field, topic texture, half-bleed, full-bleed, dark field |
| `textBudget` | Max visible text, expressed as labels, callouts, bullets, or character count |

Reject the storyboard if any content slide has `primaryVisual: none`, if three
consecutive slides use the same layout pattern, or if body text has not been
compressed into structured labels.

## Cover

- Use for: opening tone, promise, audience framing.
- Primary visual: full-slide motif, half-bleed visual, large abstract shape, big topic object, or procedural background.
- Background: dark field, full-bleed image/visual, split field, or topic texture.
- Text budget: title, subtitle, optional context/date.
- Typical patterns:
  - `hero-left-visual-right`: large title left, topic visual right.
  - `center-poster`: centered title over full-field motif.
  - `dark-object-stage`: dark background with oversized motif/object.
- Failure modes: timid title, small decoration, white background, subtitle too long.

## Agenda

- Use for: decks with 8+ slides or multiple sections.
- Primary visual: numbered navigation rail, section cards, map/path, or progress system.
- Background: canvas surface or split field.
- Text budget: 3-5 section labels, optional one-line descriptors.
- Typical patterns:
  - `numbered-rail`: large section numbers and short labels.
  - `agenda-grid`: 2x2 or 2x3 section cards.
  - `journey-map`: sections placed along a path or timeline.
- Failure modes: long descriptions, weak numbering, looks like a bullet list.

## Divider

- Use for: major transitions.
- Primary visual: oversized section number, strong color block, image field, or motif poster.
- Background: dark field, split field, full-bleed visual, or oversized motif.
- Text budget: section number, title, optional one-line setup.
- Typical patterns:
  - `oversized-number`: huge translucent number with title.
  - `split-divider`: color field plus title area.
  - `motif-poster`: section title over topic texture or illustration.
- Failure modes: ordinary content layout, tiny section number, too much text.

## Process / Timeline

- Use for: methods, workflows, phases, learning loops, implementation steps.
- Primary visual: numbered steps, loop, ladder, funnel, timeline, or connected stages.
- Background: diagram field, canvas surface, topic texture.
- Text budget: 3-6 step labels plus one-line captions.
- Typical patterns:
  - `process-ribbon`: horizontal numbered stages.
  - `process-loop`: circular or returning loop.
  - `funnel-to-output`: wide inputs narrowing to output.
  - `ladder`: vertical progression with checkpoints.
- Failure modes: paragraphs inside steps, arrows too small, labels too close.

## Comparison

- Use for: before/after, misconception/fix, option A/B, tradeoffs, pros/cons.
- Primary visual: two or three strong fields/columns with balanced content.
- Background: split field, canvas surface, or side-by-side color fields.
- Text budget: 2-4 short rows per side.
- Typical patterns:
  - `split-comparison`: two large columns.
  - `misconception-fix`: problem side muted, correction side emphasized.
  - `tradeoff-scorecard`: options as columns, criteria as rows.
- Failure modes: uneven text length, weak contrast, both sides visually identical.

## Concept Map

- Use for: abstract ideas, mental models, root causes, relationships, definitions.
- Primary visual: central node with 3-6 connected surrounding nodes.
- Background: diagram field or topic texture.
- Text budget: central phrase, 3-6 short labels, optional one-sentence takeaway.
- Typical patterns:
  - `hub-and-spoke`: core idea in center.
  - `cause-map`: causes flow into outcome.
  - `layers-map`: nested circles or stacked layers.
- Failure modes: too many nodes, long node text, connectors through words.

## Framework Canvas

- Use for: strategy, models, matrices, operating systems, planning tools.
- Primary visual: 2x2, 2x3, layers, scorecard, decision map, or quadrant.
- Background: canvas surface or split field.
- Text budget: 4-6 cells with short labels and one-line details.
- Typical patterns:
  - `canvas-2x2`: quadrant framework.
  - `layer-stack`: layers or maturity levels.
  - `decision-map`: criteria leading to recommendation.
- Failure modes: dense paragraphs, unstable grid alignment, too many colors.

## Data Insight

- Use for: metrics, research findings, market sizing, survey results, benchmarks.
- Primary visual: chart, large stat, benchmark bar, ring, slope, or data cards.
- Background: canvas surface, dark field, or insight strip.
- Text budget: one headline insight, 1-3 takeaways, source note if data is external.
- Typical patterns:
  - `hero-stat`: large number plus explanation.
  - `chart-left-takeaways-right`: chart as hero, short takeaways.
  - `benchmark-bars`: ranked bars or progress bands.
- Failure modes: invented data, default chart styling, tiny labels, no source.

## Mixed Media

- Use for: concrete examples, product flows, scenes, screenshots, people, objects.
- Primary visual: image/screenshot/illustration occupying 35-55% of slide.
- Background: half-bleed visual, full-bleed with overlay, or canvas surface.
- Text budget: title, 2-4 callouts, captions.
- Typical patterns:
  - `half-bleed-right`: visual on right, structured text on left.
  - `annotated-surface`: screenshot/wireframe with numbered callouts.
  - `image-plus-grid`: large image plus 2x2 explanation grid.
- Failure modes: small unreadable image, promised image absent, decorative photo with no explanatory purpose.

## Case / Example

- Use for: training scenarios, sales stories, applications, demonstrations.
- Primary visual: scenario card, annotated example, before/after scene, or lesson panel.
- Background: canvas surface, split field, half-bleed.
- Text budget: situation, action, result, lesson.
- Typical patterns:
  - `scenario-lesson`: situation left, lesson right.
  - `example-strip`: visual example with 3 annotations.
  - `before-action-result`: three-stage story.
- Failure modes: story too long, no visual evidence, lesson hidden in body copy.

## Recap Matrix

- Use for: section summaries, takeaways, implementation checklist, classroom exercises.
- Primary visual: table-like matrix, checklist canvas, action grid.
- Background: canvas surface or topic texture.
- Text budget: 2-4 rows, 2-3 columns, short action labels.
- Typical patterns:
  - `do-dont-matrix`: action vs avoid.
  - `before-during-after`: temporal summary.
  - `takeaway-grid`: 2x2 summary cards.
- Failure modes: too many rows, tiny text, no hierarchy.

## Principle Poster

- Use sparingly for: quotes, maxims, core principles, emotional turning points.
- Primary visual: oversized quote/principle plus large motif or strong background.
- Background: dark field, full-bleed, topic texture, or oversized motif.
- Text budget: one short sentence plus 1-3 labels.
- Typical patterns:
  - `quote-poster`: large centered sentence.
  - `principle-left-motif-right`: principle plus large symbolic visual.
  - `poster-stack`: statement, subtitle, tiny supporting labels.
- Failure modes: ordinary text slide, long quote, decorative underline.

## Closing

- Use for: final takeaway, CTA, next steps, memorable finish.
- Primary visual: strong motif return, recap matrix, CTA path, or poster statement.
- Background: dark field, full-bleed visual, split field, or oversized motif.
- Text budget: 1 closing statement, up to 3 takeaways or next steps, optional contact.
- Typical patterns:
  - `dark-closing-poster`: strong statement on dark field.
  - `recap-plus-action`: three takeaways and next step.
  - `loop-complete`: motif from cover returns as final visual.
- Failure modes: weak thank-you slide, too many bullets, no relationship to cover.

## Layout Rotation Rules

- Plan the entire deck before coding. Verify neighboring slides do not share the
  same layout key too often.
- Use recurring motif and palette to create coherence; use layout variation to
  prevent monotony.
- In a 9-10 slide deck, include at least:
  - one cover or divider visual moment
  - two process/timeline or concept map slides
  - one comparison or framework canvas
  - one recap/closing visual
- If a slide starts as bullets, first ask which structure the bullets imply:
  sequence -> process; contrast -> comparison; relationship -> concept map;
  categories -> framework canvas; evidence -> data insight; application -> case.

## Text Budgets

| Slide type | Target visible text |
| --- | --- |
| Cover | title + subtitle |
| Agenda | 3-5 short section labels |
| Divider | section number + title + optional one-liner |
| Process | 3-6 labels, captions under 12 words each |
| Comparison | 2-4 balanced rows per side |
| Concept Map | 3-6 short nodes |
| Framework Canvas | 4-6 cells, one short detail each |
| Data Insight | one headline, 1-3 takeaways, source |
| Mixed Media | 2-4 callouts |
| Case / Example | situation/action/result/lesson |
| Recap Matrix | 2-4 rows |
| Principle Poster | one sentence + 1-3 labels |
| Closing | 1 statement + up to 3 takeaways |

If visible text exceeds the budget, split the slide or switch to a denser
structure intentionally.
