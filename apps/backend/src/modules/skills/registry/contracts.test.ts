import assert from "node:assert/strict";
import { test } from "vitest";
import {
  deriveRegistrySlug,
  submitRegistrySkillRequestSchema,
  submitRegistrySkillResponseSchema,
} from "./contracts";

test("submit request accepts a trimmed repoUrl and rejects empty", () => {
  const parsed = submitRegistrySkillRequestSchema.parse({
    repoUrl: "  https://github.com/acme/skill  ",
  });
  // Shorthand and full URLs both pass through — normalization is server-side.
  assert.equal(parsed.repoUrl, "https://github.com/acme/skill");
  assert.ok(
    submitRegistrySkillRequestSchema.safeParse({ repoUrl: "acme/skill" })
      .success,
  );

  assert.equal(
    submitRegistrySkillRequestSchema.safeParse({ repoUrl: "" }).success,
    false,
  );
  assert.equal(
    submitRegistrySkillRequestSchema.safeParse({ repoUrl: "   " }).success,
    false,
  );
  assert.equal(submitRegistrySkillRequestSchema.safeParse({}).success, false);
});

test("submit response constrains status and keeps slug optional", () => {
  assert.ok(
    submitRegistrySkillResponseSchema.safeParse({
      status: "indexed",
      skills: [],
      slug: "gh-a-b",
    }).success,
  );
  assert.ok(
    submitRegistrySkillResponseSchema.safeParse({ status: "queued", skills: [] }).success,
  );
  assert.equal(
    submitRegistrySkillResponseSchema.safeParse({ status: "active" }).success,
    false,
  );
});

test("slug: base form is sanitized to [a-z0-9-] and deterministic", () => {
  const slug = deriveRegistrySlug("My.Org", "Cool_Repo!", "My Skill");
  assert.equal(slug, "gh-my-org-cool-repo-my-skill");
  assert.match(slug, /^[a-z0-9-]+$/u);
  // Deterministic — same inputs, same slug.
  assert.equal(deriveRegistrySlug("My.Org", "Cool_Repo!", "My Skill"), slug);
  // A name that sanitizes to nothing degrades to the owner/repo base.
  assert.equal(deriveRegistrySlug("acme", "skill", ""), "gh-acme-skill");
  assert.equal(deriveRegistrySlug("acme", "skill", "  "), "gh-acme-skill");
  assert.equal(deriveRegistrySlug("acme", "skill", "/"), "gh-acme-skill");
});

test("slug: distinct skills in one repo never collide, and stay readable", () => {
  const a = deriveRegistrySlug("acme", "skills", "brand-guidelines");
  const b = deriveRegistrySlug("acme", "skills", "internal-comms");
  assert.notEqual(a, b);
  // Readable, not a digest — this string is the /skills/<name>/ mount segment
  // and the label the model sees in its available-skills list.
  assert.equal(a, "gh-acme-skills-brand-guidelines");
  assert.equal(b, "gh-acme-skills-internal-comms");

  // Deterministic.
  assert.equal(a, deriveRegistrySlug("acme", "skills", "brand-guidelines"));

  // The skill name is what disambiguates, not the directory it sits in: two
  // different directories declaring the same frontmatter name collide by
  // design (the submit loop skips the duplicate).
  assert.equal(
    deriveRegistrySlug("acme", "skills", "shared"),
    deriveRegistrySlug("acme", "skills", "shared"),
  );
});

test("submit response retains per-item failure diagnostics", () => {
  const skills = [{sourcePath:"broken",status:"failed",flags:[],diagnostics:[{code:"SKILL_YAML_INVALID",severity:"error",message:"Invalid YAML",file:"SKILL.md",line:3}]}];
  assert.deepEqual(submitRegistrySkillResponseSchema.parse({status:"queued",skills}).skills,skills);
});
