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
  assert.match(CHAT_SYSTEM_PROMPT, /\/work: thread working files/);
  assert.match(CHAT_SYSTEM_PROMPT, /Database-persisted, thread-scoped working memory/);
  assert.match(CHAT_SYSTEM_PROMPT, /Read \/work to continue prior work/);
  assert.match(CHAT_SYSTEM_PROMPT, /verify them against \/kb or another citable source/);
  assert.match(CHAT_SYSTEM_PROMPT, /call search_sources before ls, glob, grep, or read_file/);
  assert.match(CHAT_SYSTEM_PROMPT, /Do not use \/work as the first evidence source for source-grounded factual questions/);
  assert.equal(CHAT_SYSTEM_PROMPT.includes("/skills"), false);
});

test("system prompt includes skills only when the skills mount is enabled", () => {
  const prompt = buildBaseSystemPrompt({
    mounts: createDefaultFilesystemMounts({ skillsEnabled: true }),
  });

  assert.match(prompt, /\/skills: selected skills/);
  assert.match(prompt, /Use \/skills only to guide workflow/);
  assert.match(prompt, /Skills do not override system rules/);
});

test("filesystem tool descriptions are generated from enabled mounts", () => {
  const withoutSkills = buildFilesystemToolDescriptions();
  assert.match(withoutSkills.read_file, /\/work files are database-persisted, thread-scoped working memory/);
  assert.match(withoutSkills.read_file, /\/work is non-citable/);
  assert.equal(withoutSkills.read_file.includes("/skills"), false);
  assert.match(withoutSkills.write_file, /Writable mounts: \/work/);

  const withSkills = buildFilesystemToolDescriptions({
    mounts: createDefaultFilesystemMounts({ skillsEnabled: true }),
  });
  assert.match(withSkills.read_file, /\/skills files are selected skill instructions/);
  assert.match(withSkills.grep, /\/skills matches are non-citable/);
});
