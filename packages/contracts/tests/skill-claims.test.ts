import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSkillClaimRepo,
  startSkillClaimRequestSchema,
} from "../src/skill-claims";

test("a repository is owner/repo, lowercased", () => {
  assert.deepEqual(parseSkillClaimRepo(" Acme-Labs/Skills.v2 "), {
    owner: "acme-labs",
    name: "skills.v2",
  });
  assert.deepEqual(parseSkillClaimRepo("a/b_c-d"), { owner: "a", name: "b_c-d" });
});

test("anything that could escape a GitHub API path is refused", () => {
  for (const value of [
    "",
    "acme",
    "acme/",
    "/skills",
    "acme/skills/extra",
    "acme/..",
    "acme/.",
    "-acme/skills",
    "acme-/skills",
    "ac--me/skills",
    "acme/sk ills",
    "acme/sk%2fills",
    "https://github.com/acme/skills",
    `${"a".repeat(40)}/skills`,
    `acme/${"s".repeat(101)}`,
  ]) {
    assert.equal(parseSkillClaimRepo(value), null, value);
  }
});

test("starting a claim names a repository and a known method, nothing else", () => {
  assert.equal(
    startSkillClaimRequestSchema.safeParse({
      repo: "acme/skills",
      method: "verification_file",
    }).success,
    true,
  );
  assert.equal(
    startSkillClaimRequestSchema.safeParse({
      repo: "acme/skills",
      method: "admin_grant",
    }).success,
    false,
  );
  assert.equal(
    startSkillClaimRequestSchema.safeParse({
      repo: "acme/skills",
      method: "github_account",
      userId: "someone-else",
    }).success,
    false,
  );
  assert.equal(
    startSkillClaimRequestSchema.safeParse({
      repo: "acme/../skills",
      method: "github_account",
    }).success,
    false,
  );
});
