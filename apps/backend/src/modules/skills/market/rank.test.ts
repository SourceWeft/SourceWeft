import assert from "node:assert/strict";
import { test } from "vitest";
import {
  type SkillRankSignals,
  compareRecommendedSkills,
  skillRankScore,
  skillRatingRankTerm,
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

test("trust runs ours, the workspace's own, featured, verified, community", () => {
  assert.equal(skillTrustTier({ sourceType: "builtin" }), 0);
  assert.equal(skillTrustTier({ sourceType: "workspace_custom" }), 1);
  assert.equal(skillTrustTier({ sourceType: "team_custom" }), 1);
  assert.equal(
    skillTrustTier({ sourceType: "registry_github", featured: true }),
    2,
  );
  // Both counts as featured.
  assert.equal(
    skillTrustTier({
      sourceType: "registry_github",
      featured: true,
      verified: true,
    }),
    2,
  );
  assert.equal(
    skillTrustTier({ sourceType: "registry_github", verified: true }),
    3,
  );
  assert.equal(
    skillTrustTier({ sourceType: "registry_github", verified: false }),
    4,
  );
  // Verified and featured are granted, so their absence is "no".
  assert.equal(skillTrustTier({ sourceType: "registry_github" }), 4);
  // Only a community skill can be featured; the flag cannot lift anything
  // above ours or the workspace's own.
  assert.equal(skillTrustTier({ sourceType: "builtin", featured: true }), 0);
  assert.equal(
    skillTrustTier({ sourceType: "workspace_custom", featured: true }),
    1,
  );
});

test("the ladder: builtin, custom, featured, verified, community — whatever the installs", () => {
  assert.deepEqual(
    order([
      skill("community-popular", { installCount: 900, repoStars: 90_000 }),
      skill("verified", { verified: true, installCount: 50 }),
      skill("featured-new", { featured: true }),
      skill("team", { sourceType: "team_custom" }),
      skill("builtin", { sourceType: "builtin" }),
    ]),
    ["builtin", "team", "featured-new", "verified", "community-popular"],
  );
  // Within featured: verified as well goes first, as the SQL's
  // (featured, verified, …) has it; then the rank score, as everywhere else.
  assert.deepEqual(
    order([
      skill("featured-few", { featured: true, installCount: 1 }),
      skill("featured-many", { featured: true, installCount: 30 }),
      skill("featured-verified", {
        featured: true,
        verified: true,
        installCount: 0,
      }),
    ]),
    ["featured-verified", "featured-many", "featured-few"],
  );
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

test("the rating counts from five visible reviews on, smoothed toward 3.5", () => {
  // Too few reviews, or none: nothing, whatever the average.
  assert.equal(skillRatingRankTerm({}), 0);
  assert.equal(skillRatingRankTerm({ ratingCount: 4, ratingAvg: 5 }), 0);
  assert.equal(skillRatingRankTerm({ ratingCount: 9, ratingAvg: null }), 0);
  // Five fives: (5*3.5 + 5*5) / 10 = 4.25, 60 * 0.75 = 45.
  assert.equal(skillRatingRankTerm({ ratingCount: 5, ratingAvg: 5 }), 45);
  // Five ones: (17.5 + 5) / 10 = 2.25, 60 * -1.25 = -75.
  assert.equal(skillRatingRankTerm({ ratingCount: 5, ratingAvg: 1 }), -75);
  // The prior itself moves nothing.
  assert.equal(skillRatingRankTerm({ ratingCount: 40, ratingAvg: 3.5 }), 0);
  // (17.5 + 20 * 4.2) / 25 = 4.06, 60 * 0.56 = 33.6.
  assert.equal(skillRatingRankTerm({ ratingCount: 20, ratingAvg: 4.2 }), 34);
  // A negative half rounds away from zero, as PostgreSQL's `round` does
  // (`Math.round` would give -7): (17.5 + 5 * 3.25) / 10 = 3.375, and
  // 60 * -0.125 = -7.5 exactly.
  assert.equal(skillRatingRankTerm({ ratingCount: 5, ratingAvg: 3.25 }), -8);
});

test("the rating term is bounded: never as much as two installs", () => {
  const many = 1_000_000;
  const best = skillRatingRankTerm({ ratingCount: many, ratingAvg: 5 });
  const worst = skillRatingRankTerm({ ratingCount: many, ratingAvg: 1 });
  assert.ok(best > 0 && best <= 90, `best ${best}`);
  assert.ok(worst < 0 && worst >= -150, `worst ${worst}`);
});

test("the rank score adds the rating term and never goes below 0", () => {
  assert.equal(
    skillRankScore({ installCount: 3, ratingCount: 5, ratingAvg: 5 }),
    345,
  );
  assert.equal(
    skillRankScore({ installCount: 3, ratingCount: 5, ratingAvg: 1 }),
    225,
  );
  // A badly rated skill nobody uses ranks with the unrated ones.
  assert.equal(skillRankScore({ ratingCount: 50, ratingAvg: 1 }), 0);
});

test("a great rating breaks a tie in installs but does not beat an install lead of two", () => {
  assert.deepEqual(
    order([
      skill("unrated", { installCount: 4 }),
      skill("loved", { installCount: 4, ratingCount: 30, ratingAvg: 4.9 }),
      skill("hated", { installCount: 4, ratingCount: 30, ratingAvg: 1.2 }),
    ]),
    ["loved", "unrated", "hated"],
  );
  assert.deepEqual(
    order([
      skill("loved", { installCount: 4, ratingCount: 500, ratingAvg: 5 }),
      skill("used", { installCount: 6 }),
    ]),
    ["used", "loved"],
  );
});
