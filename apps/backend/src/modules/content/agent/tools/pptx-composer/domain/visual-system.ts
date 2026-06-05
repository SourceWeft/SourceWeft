import type { DeckDesignSystem, deckDensities } from "./schemas";

export const visualSystemPresetIds = [
  "modern-business",
  "consulting-report",
  "premium-minimal",
  "dark-tech",
  "education-friendly",
  "data-story",
] as const;

export type VisualSystemPresetId = (typeof visualSystemPresetIds)[number];

export type VisualSystemIssueCode =
  | "STYLE_TOKEN_CONTRAST_REPAIRED"
  | "STYLE_TOKEN_MIN_FONT_REPAIRED"
  | "STYLE_TOKEN_PALETTE_TRUNCATED"
  | "STYLE_TOKEN_DENSITY_FALLBACK"
  | "STYLE_TOKEN_HEX_FALLBACK";

export type VisualSystemIssue = {
  code: VisualSystemIssueCode;
  severity: "warning";
  path: Array<string | number>;
  message: string;
};

type DeckDensity = (typeof deckDensities)[number];

type VisualPalette = DeckDesignSystem["palette"] & {
  chartColors: string[];
};

export type VisualSystemTokens = {
  name: string;
  palette: VisualPalette;
  typography: DeckDesignSystem["typography"] & {
    headingSizePt: number;
    bodySizePt: number;
    captionSizePt: number;
  };
  density: DeckDesignSystem["density"];
  layoutPrinciples: string[];
  brandNotes?: string;
};

export type ResolveVisualSystemInput = {
  explicitStylePrompt?: Partial<VisualSystemTokens> & {
    prompt?: string;
  };
  brandTokens?: Partial<VisualSystemTokens> | DeckDesignSystem;
  presetId?: VisualSystemPresetId;
  inferredDefault?: Partial<VisualSystemTokens>;
  seed?: string;
};

export type ResolveVisualSystemResult = {
  tokens: VisualSystemTokens;
  issues: VisualSystemIssue[];
};

const HEX_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const VALID_DENSITIES = new Set<DeckDensity>(["airy", "balanced", "dense"]);
const MIN_HEADING_SIZE_PT = 24;
const MIN_BODY_SIZE_PT = 14;
const MIN_CAPTION_SIZE_PT = 10;
const MAX_CHART_COLORS = 6;

const FALLBACK_LIGHT = {
  background: "#FFFFFF",
  foreground: "#111827",
  accent: "#2563EB",
  muted: "#64748B",
  surface: "#F8FAFC",
  chartColors: ["#2563EB", "#16A34A", "#F59E0B", "#DC2626", "#7C3AED", "#0891B2"],
};

const FALLBACK_DARK = {
  background: "#0F172A",
  foreground: "#F8FAFC",
  accent: "#38BDF8",
  muted: "#94A3B8",
  surface: "#1E293B",
  chartColors: ["#38BDF8", "#A78BFA", "#34D399", "#FBBF24", "#FB7185", "#22D3EE"],
};

const PRESETS: Record<VisualSystemPresetId, VisualSystemTokens> = {
  "modern-business": {
    name: "Modern Business",
    palette: FALLBACK_LIGHT,
    typography: { family: "Aptos", scale: "standard", headingSizePt: 30, bodySizePt: 16, captionSizePt: 11 },
    density: "balanced",
    layoutPrinciples: ["Clear hierarchy", "Confident whitespace", "Crisp section rhythm"],
  },
  "consulting-report": {
    name: "Consulting Report",
    palette: {
      background: "#F8FAFC",
      foreground: "#0F172A",
      accent: "#1D4ED8",
      muted: "#475569",
      surface: "#FFFFFF",
      chartColors: ["#1D4ED8", "#0F766E", "#B45309", "#BE123C", "#6D28D9", "#0369A1"],
    },
    typography: { family: "Aptos", scale: "compact", headingSizePt: 28, bodySizePt: 14, captionSizePt: 10 },
    density: "dense",
    layoutPrinciples: ["Executive summaries", "Evidence-led pages", "Tight comparison grids"],
  },
  "premium-minimal": {
    name: "Premium Minimal",
    palette: {
      background: "#FAF7F0",
      foreground: "#1C1917",
      accent: "#8B5E34",
      muted: "#78716C",
      surface: "#FFFDF8",
      chartColors: ["#8B5E34", "#365314", "#0F766E", "#7F1D1D", "#4C1D95", "#854D0E"],
    },
    typography: { family: "Aptos Display", scale: "expressive", headingSizePt: 34, bodySizePt: 16, captionSizePt: 11 },
    density: "airy",
    layoutPrinciples: ["Restrained surfaces", "Editorial spacing", "Few decisive accents"],
  },
  "dark-tech": {
    name: "Dark Tech",
    palette: FALLBACK_DARK,
    typography: { family: "Aptos", scale: "standard", headingSizePt: 30, bodySizePt: 15, captionSizePt: 10 },
    density: "balanced",
    layoutPrinciples: ["Dark canvas", "Signal accents", "Technical diagram pacing"],
  },
  "education-friendly": {
    name: "Education Friendly",
    palette: {
      background: "#FFFBEB",
      foreground: "#1F2937",
      accent: "#2563EB",
      muted: "#6B7280",
      surface: "#FFFFFF",
      chartColors: ["#2563EB", "#16A34A", "#EA580C", "#9333EA", "#0891B2", "#BE123C"],
    },
    typography: { family: "Aptos", scale: "expressive", headingSizePt: 32, bodySizePt: 17, captionSizePt: 11 },
    density: "airy",
    layoutPrinciples: ["Readable steps", "Warm contrast", "Instructor-friendly pacing"],
  },
  "data-story": {
    name: "Data Story",
    palette: {
      background: "#F8FAFC",
      foreground: "#111827",
      accent: "#0E7490",
      muted: "#475569",
      surface: "#FFFFFF",
      chartColors: ["#0E7490", "#2563EB", "#16A34A", "#F59E0B", "#DC2626", "#7C3AED"],
    },
    typography: { family: "Aptos", scale: "standard", headingSizePt: 29, bodySizePt: 15, captionSizePt: 10 },
    density: "balanced",
    layoutPrinciples: ["Data-first headlines", "Legible charts", "Insight before decoration"],
  },
};

export function getVisualSystemPreset(id: VisualSystemPresetId): VisualSystemTokens {
  return cloneTokens(PRESETS[id]);
}

export function resolveVisualSystem(input: ResolveVisualSystemInput): ResolveVisualSystemResult {
  const preset = getVisualSystemPreset(input.presetId ?? "modern-business");
  const seededFallback = deriveSeededFallback(input.seed ?? input.explicitStylePrompt?.prompt ?? input.presetId);
  const merged = mergeTokens(
    mergeTokens(
      mergeTokens({ ...preset, palette: { ...preset.palette, chartColors: seededFallback.chartColors } }, input.inferredDefault),
      input.presetId ? getVisualSystemPreset(input.presetId) : undefined,
    ),
    input.brandTokens,
  );
  return repairVisualSystemTokens(mergeTokens(merged, input.explicitStylePrompt));
}

export function validateVisualSystemTokens(tokens: VisualSystemTokens): VisualSystemIssue[] {
  const issues: VisualSystemIssue[] = [];
  for (const key of ["background", "foreground", "accent", "muted", "surface"] as const) {
    if (!isHexColor(tokens.palette[key])) {
      issues.push(issue("STYLE_TOKEN_HEX_FALLBACK", ["palette", key], `Invalid hex color for ${key}.`));
    }
  }
  tokens.palette.chartColors.forEach((color, index) => {
    if (!isHexColor(color)) {
      issues.push(issue("STYLE_TOKEN_HEX_FALLBACK", ["palette", "chartColors", index], "Invalid chart color."));
    }
  });
  if (!VALID_DENSITIES.has(tokens.density)) {
    issues.push(issue("STYLE_TOKEN_DENSITY_FALLBACK", ["density"], "Invalid density token."));
  }
  if (contrastRatio(tokens.palette.foreground, tokens.palette.background) < 4.5) {
    issues.push(issue("STYLE_TOKEN_CONTRAST_REPAIRED", ["palette", "foreground"], "Foreground/background contrast is below 4.5:1."));
  }
  if (contrastRatio(tokens.palette.accent, tokens.palette.background) < 3) {
    issues.push(issue("STYLE_TOKEN_CONTRAST_REPAIRED", ["palette", "accent"], "Accent/background contrast is below 3:1."));
  }
  if (
    tokens.typography.headingSizePt < MIN_HEADING_SIZE_PT ||
    tokens.typography.bodySizePt < MIN_BODY_SIZE_PT ||
    tokens.typography.captionSizePt < MIN_CAPTION_SIZE_PT
  ) {
    issues.push(issue("STYLE_TOKEN_MIN_FONT_REPAIRED", ["typography"], "Typography sizes are below readable minimums."));
  }
  if (tokens.palette.chartColors.length > MAX_CHART_COLORS) {
    issues.push(issue("STYLE_TOKEN_PALETTE_TRUNCATED", ["palette", "chartColors"], "Chart palette exceeds maximum color count."));
  }
  return issues;
}

export function repairVisualSystemTokens(tokens: VisualSystemTokens): ResolveVisualSystemResult {
  const repaired = cloneTokens(tokens);
  const issues = validateVisualSystemTokens(tokens);
  const prefersDark = relativeLuminance(tokens.palette.background) < 0.35;
  const fallback = prefersDark ? FALLBACK_DARK : FALLBACK_LIGHT;

  for (const key of ["background", "foreground", "accent", "muted", "surface"] as const) {
    if (!isHexColor(repaired.palette[key])) {
      repaired.palette[key] = fallback[key];
    }
  }
  repaired.palette.chartColors = repaired.palette.chartColors
    .filter(isHexColor)
    .slice(0, MAX_CHART_COLORS);
  if (repaired.palette.chartColors.length === 0) {
    repaired.palette.chartColors = fallback.chartColors.slice(0, MAX_CHART_COLORS);
  }
  if (!VALID_DENSITIES.has(repaired.density)) {
    repaired.density = "balanced";
  }
  if (contrastRatio(repaired.palette.foreground, repaired.palette.background) < 4.5) {
    repaired.palette.foreground = fallback.foreground;
    repaired.palette.background = fallback.background;
    repaired.palette.surface = fallback.surface;
    repaired.palette.muted = fallback.muted;
  }
  if (contrastRatio(repaired.palette.accent, repaired.palette.background) < 3) {
    repaired.palette.accent = fallback.accent;
  }
  repaired.typography.headingSizePt = Math.max(repaired.typography.headingSizePt, MIN_HEADING_SIZE_PT);
  repaired.typography.bodySizePt = Math.max(repaired.typography.bodySizePt, MIN_BODY_SIZE_PT);
  repaired.typography.captionSizePt = Math.max(repaired.typography.captionSizePt, MIN_CAPTION_SIZE_PT);
  repaired.palette.chartColors = repaired.palette.chartColors.slice(0, MAX_CHART_COLORS);

  return { tokens: repaired, issues: dedupeIssues(issues) };
}

export function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}

function mergeTokens(base: VisualSystemTokens, override: Partial<VisualSystemTokens> | DeckDesignSystem | undefined): VisualSystemTokens {
  if (!override) {
    return cloneTokens(base);
  }
  return {
    ...base,
    ...definedFields(override),
    palette: {
      ...base.palette,
      ...definedFields(override.palette),
      chartColors: override.palette && "chartColors" in override.palette && Array.isArray(override.palette.chartColors)
        ? [...override.palette.chartColors]
        : [...base.palette.chartColors],
    },
    typography: {
      ...base.typography,
      ...definedFields(override.typography),
    },
    layoutPrinciples: override.layoutPrinciples ? [...override.layoutPrinciples] : [...base.layoutPrinciples],
  };
}

function definedFields<T extends object>(value: T | undefined): Partial<T> {
  if (!value) {
    return {};
  }
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function cloneTokens(tokens: VisualSystemTokens): VisualSystemTokens {
  return {
    ...tokens,
    palette: { ...tokens.palette, chartColors: [...tokens.palette.chartColors] },
    typography: { ...tokens.typography },
    layoutPrinciples: [...tokens.layoutPrinciples],
  };
}

function issue(code: VisualSystemIssueCode, path: Array<string | number>, message: string): VisualSystemIssue {
  return { code, severity: "warning", path, message };
}

function dedupeIssues(issues: VisualSystemIssue[]) {
  const seen = new Set<string>();
  return issues.filter((entry) => {
    const key = `${entry.code}:${entry.path.join(".")}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isHexColor(value: string): value is `#${string}` {
  return HEX_PATTERN.test(value);
}

function relativeLuminance(hex: string): number {
  if (!isHexColor(hex)) {
    return 0;
  }
  const [r, g, b] = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)]
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function deriveSeededFallback(seed = "modern-business") {
  const hash = stableHash(seed);
  const colors = Array.from({ length: MAX_CHART_COLORS }, (_, index) =>
    hslToHex((hash + index * 47) % 360, 68, index % 2 === 0 ? 42 : 34),
  );
  return { chartColors: colors };
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function hslToHex(hue: number, saturation: number, lightness: number) {
  const s = saturation / 100;
  const l = lightness / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = hue < 60
    ? [c, x, 0]
    : hue < 120
      ? [x, c, 0]
      : hue < 180
        ? [0, c, x]
        : hue < 240
          ? [0, x, c]
          : hue < 300
            ? [x, 0, c]
            : [c, 0, x];
  return `#${[r, g, b]
    .map((channel) => Math.round((channel + m) * 255).toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase();
}
