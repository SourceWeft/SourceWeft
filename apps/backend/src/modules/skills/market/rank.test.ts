import assert from "node:assert/strict";
import { test } from "vitest";
import {
  type SkillRankSignals,
  compareRecommendedSkills,
  skillRankScore,
  skillTrustTier,
} from "./rank";

function skill(
  skillId: string,
  overrides: Partial<SkillRankSignals> = {},
): SkillRankSignals {
  return { skillId, sourceType: "registry_github", ...overrides };
}
const order = (skills: SkillRankSignals[]) =>
  [...skills].sort(compareRecommendedSkills).map((entry) => entry.skillId);

test("trust runs ours, the workspace's own, verified community, community", () => {
  assert.equal(skillTrustTier({ sourceType: "builtin" }), 0);
  assert.equal(skillTrustTier({ sourceType: "workspace_custom" }), 1);
  assert.equal(skillTrustTier({ sourceType: "team_custom" }), 1);
  assert.equal(
    skillTrustTier({ sourceType: "registry_github", verified: true }),
    2,
  );
  assert.equal(
    skillTrustTier({ sourceType: "registry_github", verified: false }),
    3,
  );
  // Verified is granted, so its absence is "no".
  assert.equal(skillTrustTier({ sourceType: "registry_github" }), 3);
});

// The point of the shared ranking: `verified` was hard-coded false, so a
// popular unvetted skill always outranked a vetted one.
test("a verified skill outranks a more installed community one", () => {
  assert.deepEqual(
    order([
      skill("community-popular", { installCount: 900 }),
      skill("verified-new", { verified: true, installCount: 1 }),
      skill("own", { sourceType: "workspace_custom" }),
      skill("builtin", { sourceType: "builtin" }),
    ]),
    ["builtin", "own", "verified-new", "community-popular"],
  );
});

test("within a trust tier: most installed, then most recently listed", () => {
  assert.deepEqual(
    order([
      skill("few", { installCount: 2 }),
      skill("many", { installCount: 40 }),
      skill("none"),
    ]),
    ["many", "few", "none"],
  );
  assert.deepEqual(
    order([
      skill("older", { installCount: 5, listedAt: "2026-01-01T00:00:00.000Z" }),
      skill("never", { installCount: 5, listedAt: null }),
      skill("newer", { installCount: 5, listedAt: "2026-09-01T00:00:00.000Z" }),
    ]),
    ["newer", "older", "never"],
  );
});

test("the id settles what nothing else does, so the order is total", () => {
  const tied = [skill("a"), skill("c"), skill("b")];
  assert.deepEqual(order(tied), ["c", "b", "a"]);
  assert.deepEqual(order([...tied].reverse()), ["c", "b", "a"]);
  assert.equal(compareRecommendedSkills(skill("a"), skill("a")), 0);
});

test("the rank score: installs count linearly, stars on a log scale", () => {
  assert.equal(skillRankScore({}), 0);
  assert.equal(skillRankScore({ installCount: 3 }), 300);
  // round(100 * ln(11)) = 240, round(100 * ln(1001)) = 691.
  assert.equal(skillRankScore({ repoStars: 10 }), 240);
  assert.equal(skillRankScore({ installCount: 2, repoStars: 1000 }), 891);
  // Nonsense in, nothing out of range.
  assert.equal(skillRankScore({ installCount: -4, repoStars: -9 }), 0);
  assert.equal(skillRankScore({ installCount: 1e12 }), 2_147_483_647);
});

test("within a trust tier stars lift a skill, but installs weigh more", () => {
  assert.deepEqual(
    order([
      skill("starred", { repoStars: 5000 }),
      skill("plain"),
      skill("used", { installCount: 9 }),
    ]),
    ["used", "starred", "plain"],
  );
});
