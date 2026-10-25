import { describe, expect, test } from "vitest";
import type { IconDecision } from "./dry-run-types";
import { renderReviewHtml, selectReviewSample, stratumOf, type ReviewRow } from "./review-sample";

function row(n: number, source: string | null, current = "registry"): ReviewRow {
  const decision: IconDecision = {
    version: 1,
    decidedAt: "2026-10-24T00:00:00.000Z",
    site: { tier: "A", reasons: [] },
    outcome: source ? "pick" : "placeholder",
    ...(source
      ? {
          pick: {
            source: source as never,
            url: `https://x.test/${n}.png`,
            sha256: String(n).padStart(64, "0"),
            storedUrl: `https://assets.test/market/mcp-icons/by-hash/${n}.png`,
            width: 128,
            height: 128,
            tier: "A" as const,
          },
        }
      : {}),
    reasons: ["why"],
    disagreement: n % 2 === 0,
    current: { iconSource: current, iconUrl: `https://old.test/${n}.png` },
  };
  return { identifier: `io.github.x/s-${n}`, version: "1.0.0", decision };
}

describe("selectReviewSample", () => {
  const rows = [
    ...Array.from({ length: 300 }, (_, i) => row(i, "site")),
    ...Array.from({ length: 60 }, (_, i) => row(1000 + i, "github-avatar")),
    ...Array.from({ length: 6 }, (_, i) => row(2000 + i, null)),
    // Same as today: never sampled.
    { ...row(3000, "registry", "registry"), decision: { ...row(3000, "registry").decision, current: { iconSource: "registry", iconUrl: "https://x.test/3000.png" } } },
  ];

  test("samples the requested size, stratified, only from entries that differ", () => {
    const { sample, summary } = selectReviewSample(rows, { size: 200, seed: 7 });
    expect(sample).toHaveLength(200);
    expect(summary.differing).toBe(366);
    expect(summary.entriesWithDecision).toBe(367);
    // Every stratum is represented; small strata are taken whole.
    expect(summary.sampled["placeholder"]).toBe(6);
    expect(summary.sampled["github-avatar"]).toBe(60);
    expect(Object.values(summary.sampled).reduce((a, b) => a + b, 0)).toBe(200);
    expect(sample.some((r) => r.identifier.endsWith("s-3000"))).toBe(false);
    expect(new Set(sample.map((r) => r.identifier)).size).toBe(200);
  });

  test("the same seed gives the same sample, another seed another", () => {
    const a = selectReviewSample(rows, { size: 50, seed: 1 }).sample.map((r) => r.identifier);
    const b = selectReviewSample(rows, { size: 50, seed: 1 }).sample.map((r) => r.identifier);
    const c = selectReviewSample(rows, { size: 50, seed: 2 }).sample.map((r) => r.identifier);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  test("fewer differing entries than the size returns them all", () => {
    expect(selectReviewSample(rows.slice(0, 5), { size: 200, seed: 1 }).sample).toHaveLength(5);
    expect(selectReviewSample([], { size: 200, seed: 1 }).sample).toEqual([]);
  });
});

describe("renderReviewHtml", () => {
  test("shows old and new images, escapes text and refuses non-https images", () => {
    const hostile = row(1, "site");
    hostile.identifier = '<img src=x onerror=alert(1)>';
    hostile.decision.current.iconUrl = "javascript:alert(1)";
    const { sample, summary } = selectReviewSample([hostile, row(2, null)], { size: 10, seed: 1 });
    const html = renderReviewHtml(sample, summary, new Date("2026-10-24T00:00:00Z"));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('src="https://assets.test/market/mcp-icons/by-hash/1.png"');
    // A publisher-supplied address is a link, never an <img> that loads it.
    expect(html).not.toContain('src="https://old.test');
    expect(html).toContain(">old.test</a>");
    expect(html).toContain("letter placeholder");
    expect(stratumOf(row(1, "site").decision)).toBe("site");
  });
});
