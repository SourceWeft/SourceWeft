import assert from "node:assert/strict";
import { test } from "vitest";
import {
  classifySkillCategories,
  getSkillCategoryDefinition,
  SKILL_FALLBACK_CATEGORY_SLUG,
  skillCategoryDefinitions,
} from "./taxonomy";

test("every category slug is unique and the fallback exists", () => {
  const slugs = skillCategoryDefinitions.map((definition) => definition.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  assert.ok(getSkillCategoryDefinition(SKILL_FALLBACK_CATEGORY_SLUG));
});

test("a skill is filed by what its name and description say", () => {
  assert.equal(
    classifySkillCategories({
      name: "pptx",
      description:
        "Use this skill any time a .pptx file is involved: creating slide decks or presentations.",
    })[0],
    "documents-office",
  );
  assert.equal(
    classifySkillCategories({
      name: "test-driven-development",
      description: "Write the unit tests first, then the code, then refactor.",
    })[0],
    "development",
  );
  assert.equal(
    classifySkillCategories({
      name: "internal-comms",
      description:
        "Write internal communications, status updates and announcements.",
    })[0],
    "communication",
  );
});

test("Chinese descriptions are classified too", () => {
  assert.deepEqual(
    classifySkillCategories({
      name: "费曼学习法",
      description: "用费曼技巧讲解一个概念，帮助学习。",
    }),
    ["learning-education"],
  );
});

test("a skill nothing matches still gets a category", () => {
  assert.deepEqual(
    classifySkillCategories({ name: "zzz", description: "qqq" }),
    [SKILL_FALLBACK_CATEGORY_SLUG],
  );
});

test("at most two categories, and only known ones", () => {
  const slugs = classifySkillCategories({
    name: "everything",
    description:
      "marketing seo emails code python design brand research analysis data sql security audit",
  });
  assert.equal(slugs.length, 2);
  for (const slug of slugs) assert.ok(getSkillCategoryDefinition(slug));
});

test("'write the test' is development, not writing", () => {
  assert.deepEqual(
    classifySkillCategories({
      name: "test-driven-development",
      description:
        "Use when implementing any feature or bugfix, before writing implementation code",
    }),
    ["development"],
  );
  assert.equal(
    classifySkillCategories({
      name: "finishing-a-development-branch",
      description:
        "Use when implementation is complete and you need to decide how to integrate the work",
    })[0],
    "development",
  );
  // Writing as a craft still lands in writing.
  assert.equal(
    classifySkillCategories({
      name: "blog-writer",
      description:
        "Draft a blog post or newsletter in the house writing style.",
    })[0],
    "writing-content",
  );
});
