/**
 * Concrete visual-language definitions for each render-profile style preset.
 *
 * The storyboard planner only carries the preset token; these directions are
 * what give the scene-code generator an actual design vocabulary to execute
 * (typography feel, color/contrast tendencies, composition, motion character),
 * so the five presets produce visibly different videos.
 */
export const VIDEO_STYLE_PRESET_DIRECTIONS: Record<
  "cinematic" | "editorial" | "executive" | "technical" | "product",
  string
> = {
  cinematic: [
    "Filmic and atmospheric: near-black backgrounds built from layered gradients with one dominant light source and deep shadow falloff.",
    "Oversized display type with tight tracking and vast negative space; a single phrase can own the whole frame.",
    "High contrast with one saturated accent hue against desaturated darks — never a busy multi-color scheme.",
    "Compose like a film frame: centered or rule-of-thirds hero statements, horizontal letterbox bands, empty regions left empty.",
    "Motion is slow and weighty — long ease curves, subtle parallax drift, gradual light reveals; nothing bouncy or abrupt.",
  ].join("\n"),
  editorial: [
    "Magazine-spread energy: paper-light or warm neutral backgrounds where typographic hierarchy does the visual work.",
    "Mix type scale dramatically — huge headlines against small kickers and captions, hairline rules, pull-quote treatments.",
    "Restrained ink-on-paper contrast with one or two muted accent colors; flat color blocks and thin dividers instead of glows or gradients.",
    "Asymmetric column grids and deliberate off-center placement, like an art-directed print layout.",
    "Motion is understated and print-like: crisp mask reveals, gentle horizontal slides, clean crossfades — never springy.",
  ].join("\n"),
  executive: [
    "Boardroom polish: composed, credible, unflashy. Deep navy/charcoal or crisp light backgrounds with generous padding.",
    "Confident sans-serif hierarchy — clear section labels, medium-weight headlines, and large standalone numbers or KPIs as the heroes.",
    "Disciplined low-saturation palette with a single corporate accent used sparingly for emphasis and data highlights.",
    "Strictly aligned symmetric or left-anchored layouts; minimal decoration — thin separators and simple stat cards, no ornament.",
    "Motion is brisk but composed: short fades, measured slide-ins, counters ticking up — professional, never playful.",
  ].join("\n"),
  technical: [
    "Diagram-first engineering aesthetic on near-black or blueprint-blue backgrounds, optionally with a faint grid texture.",
    "Monospace accents for labels, values, and annotations alongside a utilitarian sans; thin rules and connector lines give structure.",
    "Cool precise palette — schematic cyan/green accents on dark; hierarchy comes from line weight and alignment, not color saturation.",
    "Compose on an exact grid: nodes, connectors, callouts, and measured spacing take priority over decorative imagery.",
    "Motion is restrained and mechanical: draw-in strokes, staggered sequential reveals, elements snapping into alignment — no bounce, no overshoot.",
  ].join("\n"),
  product: [
    "Bright product-launch energy: vivid saturated gradients or bold solid backgrounds with soft glows and rounded geometry.",
    "Punchy modern sans-serif headlines with friendly weight contrast; short benefit-driven phrases and small feature-callout chips.",
    "Confident multi-hue palette — two or three lively colors plus clean breathing room; imagery sits in rounded, softly shadowed frames.",
    "Composition celebrates the subject: floating cards, device-style frames, and badges arranged with playful depth.",
    "Motion is springy and energetic: scale-ins with slight overshoot, pops, staggered card entrances — lively but controlled.",
  ].join("\n"),
};
