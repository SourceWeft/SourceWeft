# Asset Strategy

Use this when a deck needs photos, illustrations, screenshots, icons, logos,
textures, procedural visuals, or generated images. Assets must explain or
strengthen the message; filler visuals make decks look less polished.

## Asset Manifest

Before coding asset-heavy slides, write a small manifest:

| Field | Meaning |
| --- | --- |
| `slide` | Slide number or title |
| `assetType` | photo, illustration, screenshot, icon, logo, chart, texture, generated-raster, procedural-svg, native-shapes |
| `purpose` | What the asset explains or emphasizes |
| `source` | user-provided, official-source, generated, procedural, native-shapes |
| `fallback` | What to use if the asset is unavailable |

Do not promise an asset in slide text unless the manifest has a realistic way to
provide it.

## Source Priority

Prefer assets in this order:

1. User-provided files or source-deck assets.
2. Official or provenance-safe source assets when identity matters.
3. Generated raster assets via `generate_image` for illustrative/editorial
   visuals — at most 3 per deck, cover/hero and editorial illustration first.
   Stage each generated artifact into the sandbox with
   `prepare_sandbox_workspace` `{ artifactId, sandboxPath }` before `deck.js`
   references it.
4. Procedural SVG/PNG textures, icons, diagrams, and abstract motifs.
5. Native PptxGenJS shapes, charts, and text as editable fallbacks.

Never invent real logos, screenshots, metrics, portraits, publication covers,
customer marks, or official UI. Use generic wireframes or abstract visuals when
verified assets are unavailable.

## Asset Types

### Native Shapes

Best for editable diagrams, processes, matrices, timelines, scorecards, and
simple data views. Use native shapes for most business and teaching diagrams.

### Procedural SVG/PNG

Best for motif backgrounds and custom illustrations:

- notebook grid, blackboard grain, sticky-note texture
- blueprint grid, constellation field, graph network
- radar rings, pipeline layers, contour lines
- simple icon systems and chart-like illustrations

Use `sharp` to convert SVG to PNG when compatibility is safer.

### Screenshots

Best for product workflows and UI explanation.

- Use user-provided or official screenshots when possible.
- Crop decisively and annotate with numbered callouts.
- Do not place a tiny unreadable screenshot on a text-heavy slide.
- If a real screenshot is unavailable, use a clearly generic wireframe or
  product-surface illustration.

### Photos / Generated Images

Best for covers, dividers, mood, audience context, case examples, and visual
storytelling.

- Use overlays for readability.
- Crop around the actual subject; avoid vague atmospheric images.
- Use generated images only when the user request and environment allow it, and
  treat them as generated in QA notes.

### Icons

Icons are supporting elements. They count as primary visuals only when the slide
is a large icon system, map, or legend.

- Keep icon style consistent.
- Put icons in stable containers or badges.
- Do not use one tiny icon beside a paragraph as the only visual.

## Commercial Polish Rules

- Prefer fewer, larger assets over many tiny assets.
- Use one consistent image treatment: full-bleed, half-bleed, framed screenshot,
  or diagram field.
- Annotate assets with simple labels rather than surrounding them with bullets.
- Keep edges aligned with the grid; random floating images look unfinished.
- If a visual is decorative and does not explain anything, remove it or make it
  carry structure.

## Fallback Rules

If a promised asset is unavailable:

- Replace a photo with a native illustration or abstract motif.
- Replace a screenshot with a generic wireframe or product surface.
- Replace a logo with plain text or omit it.
- Replace a chart with a native shape data view only if the data is known.
- Remove captions or slide titles that claim the missing asset exists.

## QA Questions

Before publishing:

- Does each asset explain something?
- Is every asset large enough to read at slideshow distance?
- Are crops intentional?
- Are logos/screenshots provenance-safe?
- Is the asset treatment consistent across the deck?
- Does the contact sheet show a coherent visual system?
