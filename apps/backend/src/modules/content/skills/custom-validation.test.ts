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

test("validateCustomSkillBundle rejects custom command files", () => {
  assert.throws(
    () =>
      validateCustomSkillBundle({
        files: [
          { path: "SKILL.md", contentText: skillMd },
          {
            path: "commands/write-query.md",
            contentText: "# Write Query",
          },
        ],
      }),
    /cannot include commands/,
  );
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

test("validateCustomSkillBundle accepts models, tools, and tool defaultConfig", () => {
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
          categories: ["visual"],
          models: {
            chat: "chat-creative",
            image: "image-default",
          },
          tools: ["generate_image"],
          defaultConfig: {
            generate_image: {
              aspectRatio: "16:9",
              quality: "standard",
              style: "cartoon",
            },
          },
        }),
      },
    ],
  });

  assert.deepEqual(bundle.manifestJson.models, {
    chat: "chat-creative",
    image: "image-default",
  });
  assert.deepEqual(bundle.manifestJson.tools, ["generate_image"]);
  assert.deepEqual(bundle.manifestJson.defaultConfig, {
    generate_image: {
      aspectRatio: "16:9",
      quality: "standard",
      style: "cartoon",
    },
  });
});

test("validateCustomSkillBundle rejects defaultConfig for undeclared tools", () => {
  assert.throws(
    () =>
      validateCustomSkillBundle({
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
              categories: ["visual"],
              defaultConfig: {
                generate_image: {
                  aspectRatio: "16:9",
                },
              },
            }),
          },
        ],
      }),
    /defaultConfig requires matching tools/,
  );
});

test("validateCustomSkillBundle rejects image model without generate_image tool", () => {
  assert.throws(
    () =>
      validateCustomSkillBundle({
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
              categories: ["visual"],
              models: {
                image: "image-default",
              },
              tools: ["web_search"],
            }),
          },
        ],
      }),
    /models.image requires generate_image tool/,
  );
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
