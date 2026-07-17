import { describe, expect, it } from "vitest";
import {
  resolveLegacyVisualDeckProfile,
  resolveVisualDeckExportProfile,
} from "./profile";

describe("resolveVisualDeckExportProfile", () => {
  it("uses explicit new payload slide and pptx metadata", () => {
    expect(
      resolveVisualDeckExportProfile({
        aspectRatio: "4:3",
        pptx: { heightIn: 7.5, layout: "LAYOUT_4x3", widthIn: 10 },
        slideSize: { heightPx: 1080, widthPx: 1440 },
      }),
    ).toEqual({
      aspectRatio: "4:3",
      pptx: { heightIn: 7.5, layout: "LAYOUT_4x3", widthIn: 10 },
      slideSize: { heightPx: 1080, widthPx: 1440 },
      source: "payload",
    });
  });

  it("falls back old payloads without profile metadata to 16:9", () => {
    expect(resolveVisualDeckExportProfile({})).toEqual({
      aspectRatio: "16:9",
      pptx: { heightIn: 7.5, layout: "LAYOUT_WIDE", widthIn: 13.333 },
      slideSize: { heightPx: 1080, widthPx: 1920 },
      source: "payload_legacy",
    });
  });

  it("keeps legacy aspect ratio mapping inside the visual deck adapter", () => {
    expect(resolveLegacyVisualDeckProfile("16:10").pptx.layout).toBe(
      "LAYOUT_16x10",
    );
    expect(resolveLegacyVisualDeckProfile("4:3").slideSize).toEqual({
      heightPx: 1080,
      widthPx: 1440,
    });
  });
});
