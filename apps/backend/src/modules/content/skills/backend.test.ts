import assert from "node:assert/strict";
import test from "node:test";
import { SelectedSkillsBackend } from "./backend";
import type { EnabledSkillDescriptor } from "./types";

const skillMd = `---
name: meeting-summary
description: Use this skill when preparing meeting summaries.
---

# Meeting Summary

Summarize decisions and action items.`;

const skills: EnabledSkillDescriptor[] = [
  {
    workspaceSkillId: "workspace-skill-1",
    sourceType: "builtin",
    name: "meeting-summary",
    version: "1.0.0",
    description: "Use this skill when preparing meeting summaries.",
    files: [
      {
        path: "SKILL.md",
        contentText: skillMd,
        mimeType: "text/markdown",
        sizeBytes: Buffer.byteLength(skillMd, "utf8"),
        contentHash: "hash-skill",
      },
      {
        path: "templates/action-items.md",
        contentText: "- Owner:\n- Due date:",
        mimeType: "text/markdown",
        sizeBytes: 20,
        contentHash: "hash-template",
      },
    ],
  },
];

test("SelectedSkillsBackend lists selected skills and nested files", async () => {
  const backend = new SelectedSkillsBackend(skills);

  assert.deepEqual(await backend.ls("/"), {
    files: [{ path: "/meeting-summary/", is_dir: true }],
  });

  const result = await backend.ls("/meeting-summary");
  const files = result.files ?? [];
  assert.equal(files.length, 2);
  assert.equal(files[0]?.path, "/meeting-summary/SKILL.md");
  assert.equal(files[0]?.is_dir, false);
  assert.equal(files[0]?.size, Buffer.byteLength(skillMd, "utf8"));
  assert.equal(typeof files[0]?.modified_at, "string");
  assert.deepEqual(files[1], {
    path: "/meeting-summary/templates/",
    is_dir: true,
  });
});

test("SelectedSkillsBackend returns SKILL.md without citation or instruction headers", async () => {
  const backend = new SelectedSkillsBackend(skills);
  const result = await backend.read("/meeting-summary/SKILL.md");

  assert.equal("content" in result ? result.content : "", skillMd);
  assert.equal(
    "content" in result && typeof result.content === "string"
      ? result.content.startsWith("---\nname: meeting-summary")
      : false,
    true,
  );
  assert.equal(
    "content" in result && typeof result.content === "string"
      ? result.content.includes("Citation:")
      : true,
    false,
  );
});

test("SelectedSkillsBackend supports DeepAgents skill downloads", async () => {
  const backend = new SelectedSkillsBackend(skills);
  const [skillFile, directory, missing] = await backend.downloadFiles([
    "/meeting-summary/SKILL.md",
    "/meeting-summary",
    "/meeting-summary/missing.md",
  ]);

  assert.equal(skillFile?.path, "/meeting-summary/SKILL.md");
  assert.equal(skillFile?.error, null);
  assert.equal(
    skillFile?.content ? new TextDecoder().decode(skillFile.content) : "",
    skillMd,
  );
  assert.equal(directory?.error, "is_directory");
  assert.equal(directory?.content, null);
  assert.equal(missing?.error, "file_not_found");
  assert.equal(missing?.content, null);
});

test("SelectedSkillsBackend marks supporting files as non-citable instructions", async () => {
  const backend = new SelectedSkillsBackend(skills);
  const result = await backend.read("/meeting-summary/templates/action-items.md");

  assert.equal("content" in result, true);
  assert.equal("content" in result && typeof result.content === "string", true);
  const content = "content" in result && typeof result.content === "string"
    ? result.content
    : "";
  assert.match(content, /Skill content is workflow instruction material/);
  assert.match(content, /1: - Owner:/);
  assert.doesNotMatch(content, /\[citation:/);
});

test("SelectedSkillsBackend is read-only", async () => {
  const backend = new SelectedSkillsBackend(skills);

  assert.match(
    (await backend.write("/meeting-summary/new.md", "content")).error ?? "",
    /EROFS/,
  );
  assert.match(
    (await backend.edit("/meeting-summary/SKILL.md", "Meeting", "Call")).error ?? "",
    /EROFS/,
  );
});

test("SelectedSkillsBackend grep searches instructions without adding citations", async () => {
  const backend = new SelectedSkillsBackend(skills);
  const result = await backend.grep("action items", "/meeting-summary");

  assert.deepEqual(result.matches, [
    {
      path: "/meeting-summary/SKILL.md",
      line: 8,
      text: "Summarize decisions and action items.",
    },
  ]);
});
