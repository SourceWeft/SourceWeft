# Presentation design

Use the catalog and real layout HTML as compositional references. Give each page one job: establish a premise, compare, explain a mechanism, show evidence, or ask for a decision. Prefer specific titles and purposeful visuals over generic cards.

The default canvas is 1280×720; 4:3 uses 960×720. Keep body text at least 24px before Reveal scales the canvas. Long paragraphs and large tables should become multiple pages. Titles can vary by theme; hierarchy and useful whitespace matter more than filling the canvas.

Use flat sections with stable `data-slide-id`. The optional `data-layout` names a catalog layout; `data-theme` permits an intentional page-level theme. Image and chart data must be explicit, with meaningful labels. Use fragments only when ordering information improves the story.

The build embeds all upstream web fonts actually referenced by selected styles. Ambient system fallbacks are removed from the migrated theme stacks; fixed CJK and symbol faces complete their coverage. Original theme colors, shape rules and typography roles remain in the skill. A missing glyph is a failure, not permission to switch fonts.
