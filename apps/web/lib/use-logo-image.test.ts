import { describe, expect, it } from "vitest";

import { logoBackdropFor } from "./use-logo-image";

type Pixel = [number, number, number, number];

const WHITE: Pixel = [255, 255, 255, 255];
const PALE_GRAY: Pixel = [235, 235, 235, 255];
const BLACK: Pixel = [0, 0, 0, 255];
const ORANGE: Pixel = [255, 152, 0, 255];
const CLEAR: Pixel = [255, 255, 255, 0];

/** `count` copies of each pixel, flattened to RGBA bytes. */
function pixels(...runs: [Pixel, number][]) {
  return Uint8ClampedArray.from(
    runs.flatMap(([pixel, count]) =>
      Array.from({ length: count }, () => pixel).flat(),
    ),
  );
}

describe("logoBackdropFor", () => {
  it("puts light artwork on transparency on a dark backdrop", () => {
    expect(logoBackdropFor(pixels([WHITE, 30], [CLEAR, 70]))).toBe("dark");
    expect(logoBackdropFor(pixels([PALE_GRAY, 40], [CLEAR, 60]))).toBe("dark");
  });

  it("keeps dark and colored artwork on white", () => {
    expect(logoBackdropFor(pixels([BLACK, 30], [CLEAR, 70]))).toBe("light");
    expect(logoBackdropFor(pixels([ORANGE, 30], [CLEAR, 70]))).toBe("light");
  });

  it("decides by the majority of visible pixels", () => {
    expect(logoBackdropFor(pixels([WHITE, 20], [BLACK, 10], [CLEAR, 70]))).toBe(
      "dark",
    );
    expect(logoBackdropFor(pixels([WHITE, 10], [BLACK, 20], [CLEAR, 70]))).toBe(
      "light",
    );
  });

  it("leaves opaque and empty images on the default backdrop", () => {
    // An opaque logo covers its backdrop, however light it is.
    expect(logoBackdropFor(pixels([WHITE, 100]))).toBe("light");
    expect(logoBackdropFor(pixels([CLEAR, 100]))).toBe("light");
    expect(logoBackdropFor(new Uint8ClampedArray())).toBe("light");
  });
});
