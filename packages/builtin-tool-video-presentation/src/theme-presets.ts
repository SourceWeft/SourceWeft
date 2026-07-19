/**
 * Visual theme catalog for generated video-presentation scenes. The worker
 * pipeline asks the LLM to assign one theme per slide from this fixed set;
 * the descriptions feed the assignment prompt.
 */
export const VIDEO_PRESENTATION_THEME_PRESETS = [
  "TERRA",
  "OCEAN",
  "SUNSET",
  "EMERALD",
  "ECLIPSE",
  "FROST",
  "NEBULA",
  "AURORA",
  "MIDNIGHT",
  "AMBER",
] as const;

export type VideoPresentationThemePreset =
  (typeof VIDEO_PRESENTATION_THEME_PRESETS)[number];

export const VIDEO_PRESENTATION_THEME_DESCRIPTIONS = `
TERRA: warm earth tones, terracotta, olive, organic warmth
OCEAN: teal depth, coral accents, calm and fluid
SUNSET: orange and purple energy, bold and expressive
EMERALD: green and mint, growth and clarity
ECLIPSE: black and gold, dramatic premium contrast
FROST: ice blue and silver, crisp technical clarity
NEBULA: magenta and deep purple, futuristic and mysterious
AURORA: green teal and violet, luminous transformation
MIDNIGHT: navy and silver, contemplative authority
AMBER: honey warmth and brown, wisdom and craft
`.trim();
