import assert from "node:assert/strict";
import { test } from "vitest";
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
  assert.match(CHAT_SYSTEM_PROMPT, /\/workfiles: Workfiles/);
  assert.match(
    CHAT_SYSTEM_PROMPT,
    /Database-persisted, thread-scoped Workfiles/,
  );
  assert.match(CHAT_SYSTEM_PROMPT, /Read \/workfiles to continue prior work/);
  assert.match(CHAT_SYSTEM_PROMPT, /Create Workfiles when a task is complex/);
  assert.match(
    CHAT_SYSTEM_PROMPT,
    /Do not create Workfiles just to answer a simple question/,
  );
  assert.match(
    CHAT_SYSTEM_PROMPT,
    /verify them against \/kb or another citable source/,
  );
  assert.match(
    CHAT_SYSTEM_PROMPT,
    /call search_sources before ls, glob, grep, or read_file/,
  );
  assert.match(
    CHAT_SYSTEM_PROMPT,
    /default read_file page is 100 source lines/,
  );
  assert.match(CHAT_SYSTEM_PROMPT, /explicit limits are capped at 1000/);
  assert.match(
    CHAT_SYSTEM_PROMPT,
    /User @mentions, attachment labels, and source filenames refer to Source Library entries under \/kb/,
  );
  assert.match(
    CHAT_SYSTEM_PROMPT,
    /Do not convert @mentioned source filenames into \/workfiles paths/,
  );
  assert.match(
    CHAT_SYSTEM_PROMPT,
    /Do not use \/workfiles as the first evidence source for source-grounded factual questions/,
  );
  assert.match(CHAT_SYSTEM_PROMPT, /\/workfiles Workfiles are non-citable/);
  assert.match(
    CHAT_SYSTEM_PROMPT,
    /Sensitive tool actions are reviewed by SourceWeft before execution/,
  );
  assert.match(CHAT_SYSTEM_PROMPT, /Do not narrate approval requests/);
  assert.match(
    CHAT_SYSTEM_PROMPT,
    /SourceWeft displays pending tool confirmations in the intervention UI/,
  );
  assert.match(
    CHAT_SYSTEM_PROMPT,
    /DeepAgents todo lists are user-visible progress/,
  );
  assert.match(CHAT_SYSTEM_PROMPT, /not an internal scratchpad/);
  assert.match(CHAT_SYSTEM_PROMPT, /Keep todos outcome-oriented, stage-level/);
  assert.match(CHAT_SYSTEM_PROMPT, /implementation\/preparation details/);
  assert.match(
    CHAT_SYSTEM_PROMPT,
    /summarizing, listing, or synthesizing workspace sources/,
  );
  assert.match(
    CHAT_SYSTEM_PROMPT,
    /Do not provide an uncited source summary before or after a tool approval request/,
  );
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
  assert.match(
    withoutSkills.read_file,
    /\/workfiles are database-persisted, thread-scoped Workfiles/,
  );
  assert.match(withoutSkills.read_file, /\/workfiles is non-citable/);
  assert.match(withoutSkills.read_file, /default limit is 100 source lines/);
  assert.match(withoutSkills.read_file, /explicit limits are capped at 1000/);
  assert.match(
    withoutSkills.read_file,
    /Only \/kb read_file output may include valid/,
  );
  assert.equal(withoutSkills.read_file.includes("/skills"), false);
  assert.match(withoutSkills.write_file, /Writable mounts: \/workfiles/);
  assert.match(
    withoutSkills.write_file,
    /Create a Workfile when the task is complex/,
  );
  assert.match(
    withoutSkills.write_file,
    /rewrites them to Markdown footnote references/,
  );

  const withSkills = buildFilesystemToolDescriptions({
    mounts: createDefaultFilesystemMounts({ skillsEnabled: true }),
  });
  assert.match(
    withSkills.read_file,
    /\/skills files are selected skill instructions/,
  );
  assert.match(withSkills.grep, /\/skills matches are non-citable/);
});
