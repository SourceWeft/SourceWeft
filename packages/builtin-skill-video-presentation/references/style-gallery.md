# Style Gallery

Named style recipes for the Video Presentation Agent, tuned to produce
clearly different videos. Recipes are starting points, not locked themes: keep
a recipe's palette logic and motion character, but swap the imagery nouns in
its direction to fit the topic (a circuit-trace recipe explaining farming
should trace irrigation lines instead). User-specified brand always wins —
when the user gives colors, typography, or a logo, keep the recipe's contrast
and motion and replace its colors with theirs.

## How to use a recipe

- Pick by the user's named mood ("make it feel like a documentary") or by
  topic/audience using the map at the bottom.
- Pass the recipe's Direction text as `visualDirection`, adapted to the topic.
  This is the strongest lever — it goes straight to the scene generator.
- Pass the listed `stylePreset`, `brand.colors`, and `motion` values with it.
- Recipes work at any canvas size, including vertical `1080x1920`.
- If nothing fits, write a fresh `visualDirection` with the same anatomy:
  concrete imagery + palette mood + typography feel + motion character.

## Recipes

### Chalk Talk

Blackboard classroom — patient, hand-drawn, quietly nostalgic.

- Good for: concept explainers, study and learning topics, internal training,
  "teach me X" asks.
- Direction: "Deep green blackboard surfaces where chalk diagrams, arrows, and
  underlines sketch themselves on as the narration lands. Chalk-white
  lettering with a warm cream secondary and one sticky-note yellow accent —
  handwritten feel, but clean and legible. Motion is unhurried: elements draw
  in, settle, and hold."
- Combo: `stylePreset: "technical"` +
  `brand.colors: ["#102B27", "#F5F5F0", "#F2C84B", "#97BC62"]` +
  `motion: { "pacing": "calm", "transitionStyle": "chalk-line draw-ons with soft cross-fades", "animationIntensity": "subtle" }`

### Neon Circuit

Dark-stage tech keynote — electric, glowing, high-adrenaline.

- Good for: AI and dev-tool launches, conference hype reels, gaming,
  future-facing tech topics.
- Direction: "A near-black stage lit only by neon magenta and cyan: glowing
  circuit traces, node graphs, and light streaks that pulse as each point
  lands. Oversized geometric sans type with a faint glow edge; key numbers and
  words flare on arrival. Motion is punchy — snap zooms, fast slides, elements
  that ignite into place."
- Combo: `stylePreset: "cinematic"` +
  `brand.colors: ["#0A0A12", "#FF2E97", "#00E5FF", "#7C4DFF"]` +
  `motion: { "pacing": "energetic", "transitionStyle": "snap cuts with light-streak wipes", "animationIntensity": "bold" }`

### Storybook Wash

Watercolor picture book — soft, painted, gentle.

- Good for: children's and family content, wellness, nonprofit storytelling,
  gentle origin stories.
- Direction: "Soft watercolor washes on textured paper, with dusty rose, sage,
  and sky blue blooming at the edges of every scene. Illustrated motifs —
  leaves, winding paths, small houses — appear like brushstrokes; text is a
  warm humanist serif, small and unhurried. Everything drifts: slow floats and
  dissolves that spread like wet paint."
- Combo: `stylePreset: "editorial"` +
  `brand.colors: ["#F7F2E9", "#C97B84", "#8FA98F", "#7FA8C9", "#4A4238"]` +
  `motion: { "pacing": "calm", "transitionStyle": "watercolor-bloom dissolves", "animationIntensity": "subtle" }`

### Boardroom Navy

Corporate boardroom — composed, expensive, numbers-first.

- Good for: board updates, QBRs, investor materials, financial results for
  executive audiences.
- Direction: "Deep navy fields with generous margins, thin gold rules, and one
  confident data visual per scene. Ice-blue supporting text and large tabular
  numerals; a neutral grotesque with wide-tracked uppercase labels. Motion
  stays composed — slow pans, precise fades, charts building in measured
  steps."
- Combo: `stylePreset: "executive"` +
  `brand.colors: ["#0B1F3A", "#16325C", "#CADCFC", "#D4AF37", "#FFFFFF"]` +
  `motion: { "pacing": "calm", "transitionStyle": "measured fades with stepwise chart builds", "animationIntensity": "subtle" }`

### Newsstand '72

Retro print magazine — halftone grit, loud headlines, pasted-up charm.

- Good for: culture and history pieces, trend retrospectives, opinionated
  essays, brand stories with attitude.
- Direction: "Vintage magazine spreads on cream paper stock: halftone-dot
  imagery, mustard and burnt-orange ink blocks, teal accents, and bold
  slab-serif headlines with small kicker labels. Layouts feel pasted up —
  rotated clippings, index numbers, thick rules. Motion mimics print coming
  alive: page-turn slides and clippings that drop in and settle slightly
  askew."
- Combo: `stylePreset: "editorial"` +
  `brand.colors: ["#F3EBDD", "#E0A100", "#C4552D", "#20706F", "#22201C"]` +
  `motion: { "pacing": "dynamic", "transitionStyle": "page-turn slides with drop-in clippings", "animationIntensity": "balanced" }`

### Concrete Mono

Brutalist monochrome — raw, typographic, confrontational.

- Good for: manifestos, engineering culture talks, minimal product statements,
  single-idea provocations.
- Direction: "Stark black-on-white typographic posters: enormous grotesque
  headlines, hard grid lines, zero decoration, with occasional full-black
  inverted scenes for emphasis. One idea per screen set huge; a single red
  accent appears at most once per scene. Motion is deliberately abrupt — hard
  cuts and type that stamps into place, no soft easing."
- Combo: `stylePreset: "editorial"` +
  `brand.colors: ["#000000", "#FFFFFF", "#FF3B30"]` +
  `motion: { "pacing": "dynamic", "transitionStyle": "hard cuts, no dissolves", "animationIntensity": "bold" }`

### Pastel Launchpad

Friendly consumer launch — candy-soft, rounded, optimistic.

- Good for: consumer app features, onboarding videos, lifestyle products,
  broad non-technical audiences.
- Direction: "Airy scenes on blush and baby-blue pastel fields with rounded
  cards, soft long shadows, and floating UI mockups. A rounded geometric sans
  in sentence case with generous padding; small confetti-shape accents mark
  reveal moments. Motion is springy and cheerful — cards bounce in gently and
  screens glide between feature moments."
- Combo: `stylePreset: "product"` +
  `brand.colors: ["#FFE1E6", "#D7E8FF", "#D9F2E6", "#FFF3C4", "#3A3A44"]` +
  `motion: { "pacing": "dynamic", "transitionStyle": "springy card entrances with glide transitions", "animationIntensity": "balanced" }`

### Night Observatory

Dark data mission control — precise, instrumented, data as light.

- Good for: analytics deep dives, metrics reviews, research findings,
  monitoring and infrastructure topics.
- Direction: "A dark mission-control canvas of near-black blue with faint
  gridlines, where glowing teal and amber data marks are the only light
  sources. Charts render like instruments — thin strokes, precise ticks,
  monospace axis labels, one hero number per scene. Motion is exact: counters
  tick up, lines trace on, and the camera pushes in slowly on the key datum."
- Combo: `stylePreset: "technical"` +
  `brand.colors: ["#060B14", "#0F1B2D", "#2DD4BF", "#F59E0B", "#93A4BF"]` +
  `motion: { "pacing": "calm", "transitionStyle": "trace-on lines with slow push-ins", "animationIntensity": "balanced" }`

### Golden Hour Docu

Warm documentary — photographic, human, quietly emotional.

- Good for: customer and founder stories, social impact, retrospectives, team
  culture films.
- Direction: "Full-bleed photographic scenes in golden-hour tones with light
  film grain and soft vignettes, broken up by quiet caption cards. An
  understated serif carries quotes; small spaced-caps sans labels sit as lower
  thirds, always minimal over imagery. Motion is documentary-style — slow
  push-ins on stills and gentle cross-dissolves, nothing flashy."
- Combo: `stylePreset: "cinematic"` +
  `brand.colors: ["#221A14", "#E9DCC5", "#C98A4B", "#8A5A33"]` +
  `motion: { "pacing": "calm", "transitionStyle": "slow push-ins with cross-dissolves", "animationIntensity": "subtle" }`

### Kanso Whitespace

Japanese minimalism — MA: the emptiness carries the meaning.

- Good for: design and craft topics, premium brand statements, philosophy
  pieces, portfolio intros.
- Direction: "Vast off-white emptiness where each scene places one small,
  precise element — a word, a thin rule, a single mark — off-center on an
  invisible grid. Ink-black type with one vermilion accent; a light serif or
  thin sans with wide letterspacing and no bold weights. Motion is almost
  still: one unhurried fade per scene, then a long hold."
- Combo: `stylePreset: "editorial"` +
  `brand.colors: ["#F7F5F0", "#1A1A1A", "#E34234", "#B9B5AD"]` +
  `motion: { "pacing": "calm", "transitionStyle": "single long fades with held stillness", "animationIntensity": "subtle" }`

### Festival Gradient

Gradient poster pop — loud, rhythmic, celebratory.

- Good for: event promos, community announcements, music and creator content,
  campaign kickoffs.
- Direction: "Full-bleed sunset gradients — coral into magenta into violet —
  behind oversized display type that alternates filled and outlined styles.
  Organic blob shapes float and orbit; subtle grain keeps it poster-like
  instead of glossy. Motion is loud and rhythmic: gradients drift continuously
  and type scales in on the beat."
- Combo: `stylePreset: "cinematic"` +
  `brand.colors: ["#FF6F61", "#D6336C", "#7048E8", "#2B1B5E", "#FFB020"]` +
  `motion: { "pacing": "energetic", "transitionStyle": "beat-timed scale-ins over drifting gradients", "animationIntensity": "bold" }`

### Blueprint Draft

Engineering blueprint — cyanotype precision, drafted live.

- Good for: architecture overviews, how-it-works explainers, hardware,
  infrastructure and process breakdowns.
- Direction: "A classic blueprint field of deep cyan-blue with a fine white
  grid, schematic line drawings, dimension arrows, and a stamped title block
  in the corner. All linework is hairline white or pale cyan; labels are
  engineering monospace caps with leader lines. Motion drafts each scene —
  lines extend from anchor points, dimensions snap on, assemblies build piece
  by piece."
- Combo: `stylePreset: "technical"` +
  `brand.colors: ["#123F73", "#F2F7FD", "#A8C6E8", "#E8A33D"]` +
  `motion: { "pacing": "dynamic", "transitionStyle": "draw-on linework with snap-in dimensions", "animationIntensity": "balanced" }`

## Picking a recipe

| Ask / topic                          | First choice      | Alternate         |
| ------------------------------------ | ----------------- | ----------------- |
| Teaching, learning, training         | Chalk Talk        | Storybook Wash    |
| AI / dev tools / launch hype         | Neon Circuit      | Blueprint Draft   |
| Children, wellness, nonprofits       | Storybook Wash    | Golden Hour Docu  |
| Board updates, finance, QBRs         | Boardroom Navy    | Night Observatory |
| Culture, history, retrospectives     | Newsstand '72     | Golden Hour Docu  |
| Manifesto, single bold idea          | Concrete Mono     | Kanso Whitespace  |
| Consumer app / feature launch        | Pastel Launchpad  | Festival Gradient |
| Analytics, metrics, research         | Night Observatory | Boardroom Navy    |
| Human stories, impact, culture films | Golden Hour Docu  | Storybook Wash    |
| Design, craft, premium brand         | Kanso Whitespace  | Concrete Mono     |
| Events, campaigns, creators          | Festival Gradient | Pastel Launchpad  |
| Architecture, how-it-works           | Blueprint Draft   | Night Observatory |
