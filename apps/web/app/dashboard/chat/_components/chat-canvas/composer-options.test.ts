import { describe, expect, it } from "vitest";
import {
  EMPTY_COMPOSER_OPTIONS,
  composerOptionsStatesEqual,
  isComposerOptionsStateEmpty,
  normalizeComposerOptionsState,
} from "./composer-options";

describe("composer options", () => {
  it("normalizes persisted generic option override state", () => {
    expect(
      normalizeComposerOptionsState({
        capabilityOptionOverrides: {
          generate_image: {
            aspectRatio: "16:9",
            ignored: { nested: true },
            quality: "higher",
          },
        },
        capabilityToolEnabledOverrides: {
          generate_image: true,
          invalid: "yes",
        },
        skillOptionOverrides: {
          "builtin:ppt-deck": {
            language: "en-US",
            slideCount: 6,
            stylePreset: "academic",
            visualDensity: "light",
          },
        },
      }),
    ).toEqual({
      capabilityOptionOverrides: {
        generate_image: {
          aspectRatio: "16:9",
          quality: "higher",
        },
      },
      capabilityToolEnabledOverrides: {
        generate_image: true,
      },
      skillOptionOverrides: {
        "builtin:ppt-deck": {
          language: "en-US",
          slideCount: 6,
          stylePreset: "academic",
          visualDensity: "light",
        },
      },
    });
  });

  it("falls back to an empty state for invalid input", () => {
    expect(normalizeComposerOptionsState(null)).toEqual(
      EMPTY_COMPOSER_OPTIONS,
    );
    expect(isComposerOptionsStateEmpty(normalizeComposerOptionsState([]))).toBe(
      true,
    );
  });

  it("compares normalized states by value", () => {
    expect(
      composerOptionsStatesEqual(
        normalizeComposerOptionsState({
          skillOptionOverrides: {
            "skill-1": {
              slideCount: 6,
            },
          },
        }),
        normalizeComposerOptionsState({
          skillOptionOverrides: {
            "skill-1": {
              slideCount: 6,
            },
          },
        }),
      ),
    ).toBe(true);
  });
});
