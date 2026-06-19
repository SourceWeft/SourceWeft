import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFilesystemMountPrompt,
  buildFilesystemToolDescriptions,
  createDefaultFilesystemMounts,
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
  assert.match(
    defaultPrompt,
    /call search_sources before ls, glob, grep, or read_file/,
  );
  assert.equal(defaultPrompt.includes("/skills"), false);

  const skillsPrompt = buildFilesystemMountPrompt({
    mounts: createDefaultFilesystemMounts({ skillsEnabled: true }),
  });

  assert.match(skillsPrompt, /\/skills: selected skills/);
  assert.match(skillsPrompt, /Use \/skills only to guide workflow/);
  assert.match(skillsPrompt, /\/skills is non-citable/);
});

test("filesystem tool descriptions are generated from enabled mounts", () => {
  const withoutSkills = buildFilesystemToolDescriptions();

  assert.match(withoutSkills.read_file, /default limit is 100 source lines/);
  assert.match(withoutSkills.read_file, /explicit limits are capped at 1000/);
  assert.match(withoutSkills.read_file, /Do not use read_file for binary files/);
  assert.match(withoutSkills.read_file, /images, PDFs, PPTX decks/);
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
});
