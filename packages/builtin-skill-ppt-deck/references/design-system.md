# Design System

Use this file for every from-scratch deck. The goal is a coherent visual system:
theme preset, palette dominance, motif, background rhythm, typography, and
layout mix. Do not default to generic blue or a pile of white cards.

## Design Brief

Before writing `deck.js`, state the brief in working notes:

| Field | Required decision |
| --- | --- |
| Audience and context | Who will see this deck and in what setting |
| Theme preset | One preset below, or an equivalent custom preset |
| Palette roles | Dominant, support, accent, reading background |
| Motif | One repeated topic-specific visual idea |
| Dark/light rhythm | Sandwich, all-dark premium, or all-light editorial |
| Layout mix | At least three layout families |
| Asset plan | Native shapes, procedural SVG/PNG, user assets, screenshots, or generated raster |

Reject a brief if the same palette and motif could be reused unchanged for an
unrelated business deck.

## Theme Presets

Choose the closest preset, then adapt details to the topic.

### Learning Studio

- Good for: training, learning methods, education, workshops, internal enablement.
- Palette: `102B27` blackboard, `2C5F2D` forest, `97BC62` moss, `F5F5F5` chalk cream, `F2C84B` sticky-note yellow.
- Dominant: blackboard or notebook cream. Accent: yellow or moss.
- Fonts: Microsoft YaHei for Chinese; Trebuchet MS or Calibri for English labels.
- Motif: blackboard surface, notebook lines, sticky notes, chalk arrows, correction marks, learning loop.
- Backgrounds: dark cover/closing; light notebook or canvas surfaces for content; occasional diagram field.
- Layout mix: process loop, misconception/fix, concept map, recap matrix, case/example.
- Avoid: dense lesson notes, tiny school icons, beige-only pages, decorative title underlines.

### Executive Strategy

- Good for: business strategy, board updates, finance, consulting, operating plans.
- Palette: `111827` executive charcoal, `1E2761` midnight navy, `CADCFC` ice blue, `FFFFFF` white, `D4AF37` gold accent.
- Dominant: charcoal/navy. Accent: gold or ice blue, used sparingly.
- Fonts: Calibri or Arial body; Georgia or Arial Black only for short headings with ~10% size slack.
- Motif: decision map, scorecard, dashboard tiles, portfolio grid, strategic axis.
- Backgrounds: dark cover/closing; light report surfaces; split fields for tradeoffs.
- Layout mix: framework canvas, comparison, KPI callout, roadmap, dashboard grid.
- Avoid: generic blue SaaS look, scattered cards without hierarchy, vague stock-photo metaphors.

### Product Launch

- Good for: product announcement, feature walkthrough, startup pitch, GTM, marketing.
- Palette: `2F3C7E` launch navy, `F96167` coral, `F9E795` warm gold, `FFFFFF` white, `121826` ink.
- Dominant: navy or white. Accent: coral for feature focus, gold for launch moments.
- Fonts: Arial/Calibri; use bold display only for short launch statements.
- Motif: product surface, launch path, feature modules, spotlight rings, user journey.
- Backgrounds: hero product surface, half-bleed screenshots, modular white surfaces.
- Layout mix: mixed media, feature grid, user journey, before/after, launch roadmap.
- Avoid: fake screenshots, tiny unreadable UI, feature bullets with no product visual.

### Data Report

- Good for: analytics, market reports, experiment results, research summaries.
- Palette: `1F2937` charcoal, `F2F2F2` off-white, `0D9488` teal, `EAB308` amber, `111827` black.
- Dominant: off-white or charcoal. Accent: teal for signal, amber for caution.
- Fonts: Calibri or Arial; tabular numbers should be large and clean.
- Motif: data cards, chart surfaces, insight callouts, evidence strips, benchmark bars.
- Backgrounds: canvas surfaces, dark insight pages, split field for key findings.
- Layout mix: data insight, chart + takeaway, KPI callout, comparison, recap matrix.
- Avoid: default Excel charts, too many gridlines, small labels, invented data.

### Academic Explainer

- Good for: science, research, history, medicine, public knowledge, conceptual talks.
- Palette: `003049` deep teal/navy, `FDF0D5` warm cream, `669BBC` muted blue, `C1121F` red accent, `2B2D42` ink.
- Dominant: warm cream or deep teal. Accent: red for warnings or key distinctions.
- Fonts: Cambria for English headings (QA-safe); Georgia only for short display titles with slack; Microsoft YaHei for Chinese.
- Motif: annotated diagram, field notes, citation margin, evidence board, cause-effect arrows.
- Backgrounds: cream note surface, dark section pages, diagram fields, annotated examples.
- Layout mix: concept map, annotated diagram, timeline/process, case/example, principle poster.
- Avoid: paper-like walls of text, too many citations on-slide, decorative lab icons.

### Premium Dark Tech

- Good for: AI, security, cloud, infrastructure, astronomy, high-end technical decks.
- Palette: `000814` near-black, `001D3D` deep navy, `003566` blue, `FFC300` amber, `CAF0F8` pale cyan.
- Dominant: near-black/deep navy. Accent: amber or cyan, never both everywhere.
- Fonts: Consolas for small code labels; Calibri or Arial for body.
- Motif: graph nodes, pipeline layers, console fragments, orbit paths, model cards.
- Backgrounds: dark fields, network diagrams, low-contrast grids, glowing data moments.
- Layout mix: architecture diagram, process pipeline, concept map, data callout, comparison.
- Avoid: low-contrast gray text, generic cyber gradients, decorative nodes with no meaning.

## Palette Rules

- One dominant color should carry 60-70% of visual weight.
- Supporting colors carry structure and secondary surfaces.
- Accent color is for key numbers, labels, arrows, and emphasis only.
- Use 6-character hex colors without `#` in PptxGenJS.
- Never encode opacity in 8-character hex colors. Use `transparency` for fills
  or `opacity` for shadows.
- If the user gives brand colors, build a preset around those colors while
  keeping the same dominance rules.

## Typography

| Use | Size | Notes |
| --- | --- | --- |
| Cover title | 44-64 pt | Strong hierarchy; use `fit: "shrink"` for long Chinese titles |
| Slide title | 28-38 pt | Short, high contrast |
| Section label | 18-24 pt | Bold only for labels/headings |
| Body/callout | 13-17 pt | Regular weight; avoid body bold |
| Caption/source | 9-12 pt | Muted but readable |
| Hero number | 54-84 pt | Data and KPI slides |

### Font safety (LibreOffice QA vs Office)

Font names written into the PPTX are rendered by the user's PowerPoint, but
visual QA uses LibreOffice. Prefer fonts that keep trustworthy overflow checks:

- **QA-safe body / fit-critical text**: Arial, Calibri, Cambria, Times New Roman,
  Courier New, Bookman Old Style, Century Schoolbook.
- **CJK**: Microsoft YaHei.
- **Never default to Aptos** — missing or substituted in many QA and older Office
  environments, so both preview and delivery are unreliable.
- **Personality fonts with slack** (Georgia, Trebuchet MS, Impact, Arial Black,
  Garamond, Consolas, Palatino): fine for short titles/accents if containers leave
  ~10% extra width; do not trust QA text-fit on those runs.
- If the user requests a non-safe font, use it where asked and size with slack.

Chinese or mixed Chinese-English decks:

- Use `Microsoft YaHei` as the safe CJK font.
- Keep Chinese titles shorter; move detail to subtitle or callouts.
- Use fewer bullets than English decks; prefer labels, matrices, and diagrams.
- Leave slightly more horizontal room for Chinese lines.

## Background Rhythm

Choose one rhythm and stick to it:

- **Sandwich**: dark or full-visual cover, lighter content slides, dark/punchy closing. Reliable default.
- **All-dark premium**: dark throughout with bright charts and high-contrast labels. Use for tech, security, finance, luxury.
- **All-light editorial**: light surfaces throughout, with strong image/diagram moments. Use for teaching, reports, academic explainers.

Every slide needs an intentional background treatment:

- strong solid field
- split color field
- canvas surface
- diagram field
- notebook/blackboard/topic texture
- full-bleed or half-bleed image/visual

Plain white (`FFFFFF`) is the preferred default reading surface when no brand
palette is specified and the foreground composition is strong. Do not default to
cream or beige (`F5F5DC`, `FAF0E6`, `FAEBD7`, `FFF8E1`, and similar). Cream note
surfaces are allowed only inside intentional presets such as Learning Studio or
Academic Explainer, and must sit under a clear dominant color — never as a
beige-only deck.

## Layout Families

Rotate at least three in each from-scratch deck:

- **Hero cover/closing**: oversized title, large motif, full-bleed or dark field.
- **Process / timeline**: numbered stages, arrows, loops, funnels, ladders.
- **Comparison**: before/after, misconception/fix, option A/B, tradeoff columns.
- **Concept map**: central idea with causes, signals, examples, or relationships.
- **Framework canvas**: 2x2, layers, scorecard, decision map, quadrant.
- **Data insight**: chart or large number as hero plus 2-3 takeaways.
- **Mixed media**: half-bleed image/screenshot/illustration with structured callouts.
- **Case / example**: concrete scenario, annotated surface, lesson card.
- **Recap matrix**: compact action summary, before/during/after, do/don't.

Do not repeat the same layout key on three consecutive slides.

## Topic-to-Preset Map

| Topic | First choice | Alternate | Motif cue |
| --- | --- | --- | --- |
| Learning / training | Learning Studio | Academic Explainer | loop, notebook, blackboard, sticky notes |
| Business strategy | Executive Strategy | Data Report | dashboard, decision map, matrix |
| Product / startup | Product Launch | Premium Dark Tech | product surface, launch path, modules |
| Analytics / data | Data Report | Executive Strategy | chart cards, benchmark bars, insight strip |
| Science / academic | Academic Explainer | Premium Dark Tech | annotated diagram, evidence board |
| AI / technical | Premium Dark Tech | Data Report | nodes, pipeline, model cards |
| Wellness / growth | Learning Studio | Academic Explainer | habit loop, calendar, reflection cards |

## Avoid

- Plain title + bullets unless the user explicitly asks for an outline.
- Styling only the cover while content slides remain plain.
- Title underline accents; use composition, whitespace, or background fields.
- Decorative color bars, header/footer stripes, sidebar stripes, or card edge
  stripes; use tint, shadow, icon badges, or split fields instead.
- Cream/beige as a default background when no brand or intentional theme asks
  for it.
- Defaulting to Aptos or other QA-unreliable fonts for body text.
- Generic blue when the topic suggests a stronger palette.
- Tiny icons beside paragraphs as the only visual.
- Center-aligned body paragraphs.
- Low-contrast gray text on cream, pale blue, or dark backgrounds.
- One-note palettes dominated by near-identical shades.
- Fake screenshots, fake logos, fake metrics, or promised assets that are not present.
- Stacked chart `dataLabelPosition: "outEnd"` (corrupts PowerPoint files).

## Final Visual Checklist

Before coding:

- The brief names one preset or custom equivalent.
- The motif can appear in cover, diagrams, and closing without feeling random.
- Each content slide has a meaningful visual role.
- At least three layout families are planned.
- Text has been compressed into labels, captions, callouts, or diagram nodes.

Before publishing:

- The rendered contact sheet looks like one designed deck.
- No content page looks like a document.
- Cover and closing are visually distinct.
- Repeated colors and motif create recognition without monotony.
