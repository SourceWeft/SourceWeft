# Visual Direction and Quality

What the visual options actually do downstream, and how to pick them.

## stylePreset

Sets the base art direction the scene generator designs against:

- `cinematic` — dark, filmic gradients, large type, dramatic motion. Default;
  best for storytelling and launches.
- `editorial` — magazine-like spreads, serif-friendly, restrained motion. Good
  for essays, research summaries, thought pieces.
- `executive` — clean, high-contrast, numbers-forward. Board updates, QBRs.
- `technical` — diagram-first, monospace accents, precise labels. Architecture
  overviews, how-it-works explainers.
- `product` — bright UI-demo framing, crisp callouts. Feature walkthroughs.

All five presets carry enforced visual-language directions at the generation
layer, so the preset alone already shifts palette, type, and motion;
`visualDirection` layers on top of the preset, and the most specific
instruction wins.

## visualDirection

A free-text art brief for the scene generator, layered on top of the preset.
Concrete beats abstract — name imagery, palette, and motion feel:

- "chalkboard classroom with kinetic hand-drawn diagrams, warm amber accents"
- "executive dashboard aesthetic: deep navy, gold data highlights, calm zooms"
- "playful flat-illustration style, pastel shapes morphing between concepts"

Avoid contradicting the preset (e.g. `executive` + "grungy neon collage").

## brand / motion / canvas

- `brand.colors` (up to 8) and `brand.typography` push the palette and type
  choices; pass them whenever the user names brand constraints.
- `motion.pacing` (`calm`/`dynamic`/`energetic`) and `animationIntensity`
  (`subtle`/`balanced`/`bold`) scale movement; calm+subtle for formal
  audiences.
- `canvas` defaults to 1920×1080@30fps; only override for vertical (1080×1920)
  or square targets the user asks for.

## Validation guardrails (evidence, not a fixed repair loop)

Author scenes with readable text inside `SafeArea`, bounded type relative to the
canvas, and concise on-screen copy. `validate_video_presentation` then runs
static safety/layout checks, a clean trusted Remotion build, and
beginning/middle/end runtime renders for every scene. When a vision profile
is configured it also checks rendered frames for cut-off, overlap, and contrast;
without one it records `visualChecked: false` instead of claiming visual review.
The same prepared bundle must then produce a probed, streamable final MP4.
Diagnostics are evidence for the root Agent to make a targeted semantic edit —
there is no fixed automatic repair attempt.
