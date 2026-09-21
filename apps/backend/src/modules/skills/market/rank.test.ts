import assert from "node:assert/strict";
import { test } from "vitest";
import {
  type SkillRankSignals,
  compareRecommendedSkills,
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
