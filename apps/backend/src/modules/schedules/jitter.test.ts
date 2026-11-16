import { describe, expect, it } from "vitest";
import { stableJitterMs } from "./jitter";

describe("stableJitterMs", () => {
  it("is deterministic for one key and spreads different keys", () => {
    expect(stableJitterMs("a", 60)).toBe(stableJitterMs("a", 60));
    const spread = new Set(
      Array.from({ length: 20 }, (_, i) => stableJitterMs(`key-${i}`, 60)),
    );
    expect(spread.size).toBeGreaterThan(10);
  });

  it("stays below ten percent of the interval and five minutes", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(stableJitterMs(`k${i}`, 30)).toBeLessThan(3 * 60_000);
      expect(stableJitterMs(`k${i}`, 24 * 60)).toBeLessThan(5 * 60_000);
    }
  });

  it("is zero when the interval is too short to jitter", () => {
    expect(stableJitterMs("a", 0)).toBe(0);
  });
});
