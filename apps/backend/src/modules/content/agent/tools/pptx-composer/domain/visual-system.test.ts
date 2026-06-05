import assert from "node:assert/strict";
import { test } from "vitest";
import { brandLowContrastFixture } from "../__fixtures__";
import {
  contrastRatio,
  resolveVisualSystem,
  visualSystemPresetIds,
} from "./visual-system";

test("visual system repairs brand-low-contrast tokens", () => {
  const result = resolveVisualSystem({
    brandTokens: brandLowContrastFixture.designSystem,
    presetId: "modern-business",
  });

  assert.ok(contrastRatio(result.tokens.palette.foreground, result.tokens.palette.background) >= 4.5);
  assert.ok(contrastRatio(result.tokens.palette.accent, result.tokens.palette.background) >= 3);
  assert.match(
    result.issues.map((issue) => issue.code).join("\n"),
    /STYLE_TOKEN_CONTRAST_REPAIRED/,
  );
});

test("modern-business preset resolves deterministic tokens", () => {
  const first = resolveVisualSystem({ presetId: "modern-business", seed: "launch" });
  const second = resolveVisualSystem({ presetId: "modern-business", seed: "launch" });

  assert.deepEqual(first.tokens, second.tokens);
  assert.deepEqual(first.issues, second.issues);
});

test("explicit style prompt has precedence but cannot bypass token validation", () => {
  const result = resolveVisualSystem({
    brandTokens: {
      name: "Brand System",
      typography: {
        family: "Brand Sans",
        scale: "standard",
        headingSizePt: 28,
        bodySizePt: 15,
        captionSizePt: 10,
      },
    },
    explicitStylePrompt: {
      name: "Executive Blackout",
      palette: {
        background: "#111111",
        foreground: "#111112",
        accent: "#111113",
        muted: "#222222",
        surface: "#181818",
        chartColors: ["#111114"],
      },
      typography: {
        family: "Prompt Serif",
        scale: "expressive",
        headingSizePt: 12,
        bodySizePt: 8,
        captionSizePt: 6,
      },
    },
    presetId: "consulting-report",
  });

  assert.equal(result.tokens.name, "Executive Blackout");
  assert.equal(result.tokens.typography.family, "Prompt Serif");
  assert.ok(result.tokens.typography.headingSizePt >= 24);
  assert.ok(result.tokens.typography.bodySizePt >= 14);
  assert.ok(result.tokens.typography.captionSizePt >= 10);
  assert.ok(contrastRatio(result.tokens.palette.foreground, result.tokens.palette.background) >= 4.5);
  assert.match(result.issues.map((issue) => issue.code).join("\n"), /STYLE_TOKEN_CONTRAST_REPAIRED/);
  assert.match(result.issues.map((issue) => issue.code).join("\n"), /STYLE_TOKEN_MIN_FONT_REPAIRED/);
});

test("visual system rejects invalid density and falls back deterministically", () => {
  const result = resolveVisualSystem({
    explicitStylePrompt: { density: "crowded" } as never,
    presetId: "premium-minimal",
  });

  assert.equal(result.tokens.density, "balanced");
  assert.match(result.issues.map((issue) => issue.code).join("\n"), /STYLE_TOKEN_DENSITY_FALLBACK/);
});

test("visual system caps palette count without per-slide color drift", () => {
  const result = resolveVisualSystem({
    explicitStylePrompt: {
      palette: {
        background: "#FFFFFF",
        foreground: "#111827",
        accent: "#2563EB",
        muted: "#64748B",
        surface: "#F8FAFC",
        chartColors: [
          "#111111",
          "#222222",
          "#333333",
          "#444444",
          "#555555",
          "#666666",
          "#777777",
          "#888888",
        ],
      },
    },
    presetId: "data-story",
  });

  assert.equal(result.tokens.palette.chartColors.length, 6);
  assert.equal("slidePalettes" in result.tokens, false);
  assert.match(result.issues.map((issue) => issue.code).join("\n"), /STYLE_TOKEN_PALETTE_TRUNCATED/);
});

test("visual system exposes the required v1 presets", () => {
  assert.deepEqual(visualSystemPresetIds, [
    "modern-business",
    "consulting-report",
    "premium-minimal",
    "dark-tech",
    "education-friendly",
    "data-story",
  ]);
});
