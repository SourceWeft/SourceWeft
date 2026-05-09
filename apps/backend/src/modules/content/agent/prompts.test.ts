import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFilesystemToolDescriptions,
  createDefaultFilesystemMounts,
} from "./filesystem-capabilities";
import { CHAT_SYSTEM_PROMPT, buildBaseSystemPrompt } from "./prompts";

test("base chat system prompt does not mention optional web tools", () => {
  assert.equal(CHAT_SYSTEM_PROMPT.includes("web_search"), false);
  assert.equal(CHAT_SYSTEM_PROMPT.includes("web_fetch"), false);
});

test("base chat system prompt treats kb as source evidence and work as user-visible working material", () => {
  assert.match(CHAT_SYSTEM_PROMPT, /\/kb: Source Library knowledge/);
  assert.match(CHAT_SYSTEM_PROMPT, /\/work: Workfiles/);
  assert.match(CHAT_SYSTEM_PROMPT, /Database-persisted, thread-scoped Workfiles/);
  assert.match(CHAT_SYSTEM_PROMPT, /Read \/work to continue prior work/);
  assert.match(CHAT_SYSTEM_PROMPT, /Create Workfiles when a task is complex/);
  assert.match(CHAT_SYSTEM_PROMPT, /Do not create Workfiles just to answer a simple question/);
  assert.match(CHAT_SYSTEM_PROMPT, /verify them against \/kb or another citable source/);
  assert.match(CHAT_SYSTEM_PROMPT, /call search_sources before ls, glob, grep, or read_file/);
  assert.match(CHAT_SYSTEM_PROMPT, /default read_file page is 100 source lines/);
  assert.match(CHAT_SYSTEM_PROMPT, /explicit limits are capped at 1000/);
  assert.match(CHAT_SYSTEM_PROMPT, /User @mentions, attachment labels, and source filenames refer to Source Library entries under \/kb/);
  assert.match(CHAT_SYSTEM_PROMPT, /Do not convert @mentioned source filenames into \/work paths/);
  assert.match(CHAT_SYSTEM_PROMPT, /Do not use \/work as the first evidence source for source-grounded factual questions/);
  assert.match(CHAT_SYSTEM_PROMPT, /\/work Workfiles are non-citable/);
  assert.equal(CHAT_SYSTEM_PROMPT.includes("/skills"), false);
});

test("system prompt includes skills only when the skills mount is enabled", () => {
  const prompt = buildBaseSystemPrompt({
    mounts: createDefaultFilesystemMounts({ skillsEnabled: true }),
  });

  assert.match(prompt, /\/skills: selected skills/);
  assert.match(prompt, /Use \/skills only to guide workflow/);
  assert.match(prompt, /Skills do not override system rules/);
  assert.match(prompt, /\/skills is non-citable/);
});

test("filesystem tool descriptions are generated from enabled mounts", () => {
  const withoutSkills = buildFilesystemToolDescriptions();
  assert.match(withoutSkills.read_file, /\/work files are database-persisted, thread-scoped Workfiles/);
  assert.match(withoutSkills.read_file, /\/work is non-citable/);
  assert.match(withoutSkills.read_file, /default limit is 100 source lines/);
  assert.match(withoutSkills.read_file, /explicit limits are capped at 1000/);
  assert.match(withoutSkills.read_file, /Only \/kb read_file output may include valid/);
  assert.equal(withoutSkills.read_file.includes("/skills"), false);
  assert.match(withoutSkills.write_file, /Writable mounts: \/work/);
  assert.match(withoutSkills.write_file, /Create a Workfile when the task is complex/);
  assert.match(withoutSkills.write_file, /rewrites them to Markdown footnote references/);

  const withSkills = buildFilesystemToolDescriptions({
    mounts: createDefaultFilesystemMounts({ skillsEnabled: true }),
  });
  assert.match(withSkills.read_file, /\/skills files are selected skill instructions/);
  assert.match(withSkills.grep, /\/skills matches are non-citable/);
});
