import assert from "node:assert/strict";
import test from "node:test";
import { CUSTOM_SKILL_LIMITS, validateCustomSkillBundle } from "./custom-validation";

const skillMd = `---
name: custom-review
description: Use this skill when reviewing custom material.
---

# Custom Review`;

test("validateCustomSkillBundle accepts small text-only bundles", () => {
  const bundle = validateCustomSkillBundle({
    files: [
      { path: "SKILL.md", contentText: skillMd },
      { path: "templates/output.json", contentText: '{"items":[]}' },
    ],
  });

  assert.equal(bundle.name, "custom-review");
  assert.equal(bundle.version, "0.1.0");
  assert.equal(bundle.description, "Use this skill when reviewing custom material.");
  assert.equal(bundle.files.length, 2);
  assert.equal(bundle.files[0]?.path, "SKILL.md");
  assert.equal(bundle.files[1]?.mimeType, "application/json");
  assert.deepEqual(bundle.manifestJson, {
    slug: "custom-review",
    displayName: "custom-review",
    version: "0.1.0",
    description: "Use this skill when reviewing custom material.",
    visibility: "workspace",
    categories: [],
  });
});

test("validateCustomSkillBundle accepts skill.json manifest", () => {
  const bundle = validateCustomSkillBundle({
    files: [
      { path: "SKILL.md", contentText: skillMd },
      {
        path: "skill.json",
        contentText: JSON.stringify({
          slug: "custom-review",
          displayName: "Custom Review",
          version: "1.0.0",
          description: "Use this skill when reviewing custom material.",
          visibility: "workspace",
          categories: ["review"],
        }),
      },
    ],
  });

  assert.equal(bundle.version, "1.0.0");
  assert.equal(bundle.manifestJson.slug, "custom-review");
  assert.equal(bundle.manifestJson.displayName, "Custom Review");
  assert.deepEqual(bundle.manifestJson.categories, ["review"]);
});

test("validateCustomSkillBundle rejects scripts for DB custom skills", () => {
  assert.throws(
    () =>
      validateCustomSkillBundle({
        files: [
          { path: "SKILL.md", contentText: skillMd },
          { path: "scripts/run.sh", contentText: "echo unsafe" },
        ],
      }),
    /cannot include scripts/,
  );
});

test("validateCustomSkillBundle rejects binary-like and unsupported file types", () => {
  assert.throws(
    () =>
      validateCustomSkillBundle({
        files: [
          { path: "SKILL.md", contentText: skillMd },
          { path: "asset.png", contentText: "not really png" },
        ],
      }),
    /file type is not allowed/,
  );
});

test("validateCustomSkillBundle requires valid SKILL.md frontmatter", () => {
  assert.throws(
    () =>
      validateCustomSkillBundle({
        files: [
          {
            path: "SKILL.md",
            contentText: "---\nname: Invalid Name\n---\n# Bad",
          },
        ],
      }),
    /manifest slug is invalid/,
  );
});

test("validateCustomSkillBundle enforces file count limit", () => {
  assert.throws(
    () =>
      validateCustomSkillBundle({
        files: Array.from({ length: CUSTOM_SKILL_LIMITS.fileCount + 1 }, (_, index) => ({
          path: index === 0 ? "SKILL.md" : `file-${index}.md`,
          contentText: index === 0 ? skillMd : "content",
        })),
      }),
    /exceeds 50 files/,
  );
});
