import assert from "node:assert/strict";
import { test } from "vitest";
import { discoverSkillDirectories } from "./read";

test("finds a skill at the repo root", () => {
  assert.deepEqual(discoverSkillDirectories(["SKILL.md", "README.md"]), [""]);
});

test("finds skills one level under each container", () => {
  assert.deepEqual(
    discoverSkillDirectories([
      "skills/writer/SKILL.md",
      ".claude/skills/editor/SKILL.md",
      ".agents/skills/planner/SKILL.md",
    ]),
    [".agents/skills/planner", ".claude/skills/editor", "skills/writer"],
  );
});

test("finds skills nested arbitrarily deep under a container", () => {
  // Repos that ship more than a handful group them by topic. Requiring exactly
  // one level made a 90-skill repository discover zero and be rejected outright.
  assert.deepEqual(
    discoverSkillDirectories([
      "skills/0-strategy/planning-prework-pack/SKILL.md",
      "skills/1-brand-marketing/seo/brief-writer/SKILL.md",
    ]),
    [
      "skills/0-strategy/planning-prework-pack",
      "skills/1-brand-marketing/seo/brief-writer",
    ],
  );
});

test("ignores a SKILL.md that is sample content outside the containers", () => {
  assert.deepEqual(
    discoverSkillDirectories([
      "docs/examples/demo/SKILL.md",
      "templates/SKILL.md",
      "skills/real/SKILL.md",
    ]),
    ["skills/real"],
  );
});

test("a file merely ending in SKILL.md is not a skill", () => {
  assert.deepEqual(
    discoverSkillDirectories(["skills/writer/NOT-SKILL.md"]),
    [],
  );
});
