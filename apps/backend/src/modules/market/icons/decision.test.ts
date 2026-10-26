import { describe, expect, test } from "vitest";
import { decideIcon } from "./decision";
import type { IconCandidate } from "./dry-run-types";
import type { SiteTrust } from "./site-trust";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const SITE_A: SiteTrust = { tier: "A", host: "acme.io", domain: "acme.io", reasons: ["namespace-domain:acme.io"] };
const CURRENT = { iconSource: "favicon", iconUrl: "https://assets.test/old.png" };

function accepted(
  source: IconCandidate["source"],
  tier: IconCandidate["tier"],
  n: number,
  extra: Partial<IconCandidate> = {},
): IconCandidate {
  const sha256 = n.toString(16).padStart(64, "0");
  return {
    source,
    tier,
    url: `https://example.test/${source}/${n}.png`,
    sha256,
    width: 128,
    height: 128,
    storedUrl: `https://assets.test/by-hash/${sha256}.png`,
    ...extra,
  };
}

const decide = (candidates: IconCandidate[], site: SiteTrust = SITE_A) =>
  decideIcon({ site, candidates, current: CURRENT, now: NOW });

describe("decideIcon", () => {
  test("a registry icon of the same tier beats the site's icon", () => {
    const decision = decide([accepted("site", "A", 1), accepted("registry", "A", 2)]);
    expect(decision.pick).toMatchObject({ source: "registry", tier: "A" });
    expect(decision.disagreement).toBe(true);
  });

  test("a higher tier beats a better-ranked source", () => {
    const decision = decide([accepted("registry", "B", 1), accepted("site", "A", 2)]);
    expect(decision.pick?.source).toBe("site");
  });

  test("source order within a tier: server-info, site, avatar, registry avatar, favicon", () => {
    const sources = ["favicon", "github-registry", "github-avatar", "site", "server-info"] as const;
    const picked: string[] = [];
    let remaining = sources.map((s, i) => accepted(s, "A", i + 1));
    while (remaining.length > 0) {
      const pick = decide(remaining).pick!;
      picked.push(pick.source);
      remaining = remaining.filter((c) => c.source !== pick.source);
    }
    expect(picked).toEqual(["server-info", "site", "github-avatar", "github-registry", "favicon"]);
  });

  test("tier C candidates are never picked", () => {
    const decision = decide([accepted("favicon", "C", 1)]);
    expect(decision).toMatchObject({ outcome: "placeholder", reasons: ["only-tier-c"] });
    expect(decision.pick).toBeUndefined();
  });

  test("rejected candidates are ignored", () => {
    const decision = decide([
      accepted("registry", "A", 1, { rejection: "too-small" }),
      accepted("github-avatar", "A", 2),
    ]);
    expect(decision.pick?.source).toBe("github-avatar");
    expect(decision.disagreement).toBe(false);
  });

  test("an image shared across unrelated domains is held for review, not picked", () => {
    const decision = decide([accepted("site", "A", 1, { signals: ["shared-template:5"] })]);
    expect(decision).toMatchObject({
      outcome: "placeholder",
      reasons: ["shared-template-needs-review"],
    });
    const other = decide([
      accepted("site", "A", 1, { signals: ["shared-template:5"] }),
      accepted("github-avatar", "A", 2),
    ]);
    expect(other.pick?.source).toBe("github-avatar");
  });

  test("nothing at all, or nothing accepted, is a placeholder with a reason", () => {
    expect(decide([]).reasons).toEqual(["no-candidates"]);
    expect(decide([accepted("site", "A", 1, { rejection: "svg-not-published" })]).reasons).toEqual([
      "no-accepted-candidate",
    ]);
  });

  test("the larger of two equal candidates wins and the site tier is recorded", () => {
    const decision = decide(
      [
        accepted("site", "A", 1, { width: 64, height: 64 }),
        accepted("site", "A", 2, { width: 192, height: 192 }),
      ],
      { tier: "C", declaredDomains: ["x.com"], reasons: ["single-or-unconfirmed-declaration"] },
    );
    expect(decision.pick).toMatchObject({ width: 192 });
    expect(decision.site).toEqual({ tier: "C", reasons: ["single-or-unconfirmed-declaration"] });
    expect(decision.current).toEqual(CURRENT);
  });
});
