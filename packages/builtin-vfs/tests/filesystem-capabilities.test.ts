import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFilesystemMountPrompt,
  buildFilesystemToolDescriptions,
  createDefaultFilesystemMounts,
  createSandboxFilesystemMount,
  KB_READ_FILE_DEFAULT_LINE_LIMIT,
  KB_READ_FILE_MAX_LINE_LIMIT,
} from "../src/index";

test("filesystem mounts default to citable knowledge and writable work roots", () => {
  const mounts = createDefaultFilesystemMounts();

  assert.deepEqual(
    mounts.map((mount) => ({
      root: mount.root,
      readable: mount.readable,
      writable: mount.writable,
      citable: mount.citable,
      evidenceRole: mount.evidenceRole,
    })),
    [
      {
        root: "/kb",
        readable: true,
        writable: false,
        citable: true,
        evidenceRole: "source_evidence",
      },
      {
        root: "/workfiles",
        readable: true,
        writable: true,
        citable: false,
        evidenceRole: "working_memory",
      },
    ],
  );
  assert.equal(KB_READ_FILE_DEFAULT_LINE_LIMIT, 100);
  assert.equal(KB_READ_FILE_MAX_LINE_LIMIT, 1000);
});

test("filesystem mount prompt includes skills only when the mount is enabled", () => {
  const defaultPrompt = buildFilesystemMountPrompt();

  assert.match(defaultPrompt, /\/kb: Source Library knowledge/);
  assert.match(defaultPrompt, /\/workfiles: Workfiles/);
  assert.match(defaultPrompt, /read_file reads UTF-8 text only/);
  assert.match(defaultPrompt, /read_file contract: markdown-source-view/);
  assert.match(
    defaultPrompt,
    /call search_sources before ls, glob, grep, or read_file/,
  );
  assert.equal(defaultPrompt.includes("/skills"), false);
  assert.equal(defaultPrompt.includes("/workspace"), false);

  const skillsPrompt = buildFilesystemMountPrompt({
    mounts: createDefaultFilesystemMounts({ skillsEnabled: true }),
  });

  assert.match(skillsPrompt, /\/skills: selected skills/);
  assert.match(skillsPrompt, /Use \/skills only to guide workflow/);
  assert.match(skillsPrompt, /\/skills is non-citable/);
});

test("filesystem mount prompt can include sandbox workspace contract", () => {
  const prompt = buildFilesystemMountPrompt({
    mounts: [
      ...createDefaultFilesystemMounts(),
      createSandboxFilesystemMount(),
    ],
  });

  assert.match(prompt, /\/workspace: sandbox workspace/);
  assert.match(prompt, /read_file contract: utf8-text-only; line-offset/);
  assert.match(prompt, /Denied: images, slide screenshots, PDFs/);
  assert.match(prompt, /Binary handling: use publish_artifact/);
  assert.match(prompt, /sandbox files are generated or intermediate runtime state and are non-citable/i);
});

test("filesystem tool descriptions are generated from enabled mounts", () => {
  const withoutSkills = buildFilesystemToolDescriptions();

  assert.match(withoutSkills.read_file, /default limit is 100 source lines/);
  assert.match(withoutSkills.read_file, /explicit limits are capped at 1000/);
  assert.match(withoutSkills.read_file, /Path-specific behavior:/);
  assert.match(withoutSkills.read_file, /Do not use read_file for binary files/);
  assert.match(withoutSkills.read_file, /images, slide screenshots, PDFs, PPTX decks/);
  assert.match(
    withoutSkills.read_file,
    /Only \/kb read_file output may include valid/,
  );
  assert.match(withoutSkills.write_file, /Writable mounts: \/workfiles/);
  assert.match(
    withoutSkills.write_file,
    /rewrites them to Markdown footnote references/,
  );
  assert.equal(withoutSkills.read_file?.includes("/skills"), false);

  const withSkills = buildFilesystemToolDescriptions({
    mounts: createDefaultFilesystemMounts({ skillsEnabled: true }),
  });

  assert.match(
    withSkills.read_file,
    /\/skills files are selected skill instructions/,
  );
  assert.match(withSkills.grep, /\/skills matches are non-citable/);

  const withSandbox = buildFilesystemToolDescriptions({
    mounts: [
      ...createDefaultFilesystemMounts(),
      createSandboxFilesystemMount(),
    ],
  });
  assert.match(
    withSandbox.read_file,
    /\/workspace: utf8-text-only; line-offset; read\/write; non-citable/u,
  );
  assert.match(withSandbox.read_file, /slide screenshots/u);
  assert.match(withSandbox.read_file, /publish_artifact/u);
});
