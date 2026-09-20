import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { test, vi } from "vitest";

/**
 * The REAL numbers: a skill is refused at exactly `SKILL_STORAGE_LIMITS`, the
 * limits the object store and the sandbox staging run under — and a file the
 * MCP market's 512 KiB reader default would have rejected is read.
 * (`read-bundle.test.ts` covers the behaviour around the limits with small ones.)
 */
vi.mock("../../sources/storage", () => ({}));

import { RegistrySubmissionError } from "./errors";
import { readRegistrySkillsFromArchive } from "./read";
import { SKILL_STORAGE_LIMITS } from "../storage";

const MiB = 1024 * 1024;
const source = {
  owner: "acme",
  repo: "skills",
  subpath: "",
  repoUrl: "https://github.com/acme/skills",
  sourceUrl: "https://github.com/acme/skills",
  commitSha: "a".repeat(40),
  committedAt: "2026-02-01T10:00:00.000Z",
};
const SKILL_MD = strToU8(
  "---\nname: poster\ndescription: Posters\n---\nBody\n",
);

// Zeros deflate to almost nothing, so these archives are small and fast.
function zipball(files: Record<string, Uint8Array>) {
  return Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(files).map(([path, bytes]) => [`r-abc/${path}`, bytes]),
      ),
    ),
  );
}

async function rejectionOf(files: Record<string, Uint8Array>) {
  const read = await readRegistrySkillsFromArchive(
    zipball({ "SKILL.md": SKILL_MD, ...files }),
    source,
  );
  return read.skills[0]?.rejection;
}

const tooLarge = (error: unknown) =>
  error instanceof RegistrySubmissionError &&
  error.code === "REGISTRY_SUBMISSION_TOO_LARGE";

test("the limits are the storage limits", () => {
  assert.deepEqual(SKILL_STORAGE_LIMITS, {
    maxFiles: 200,
    maxFileBytes: 10 * MiB,
    maxBundleBytes: 50 * MiB,
  });
});

test("200 files are a skill, 201 are not", async () => {
  const references = (count: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `references/${index}.md`,
        strToU8("note"),
      ]),
    );
  assert.equal(await rejectionOf(references(199)), undefined);
  const rejection = await rejectionOf(references(200));
  assert.ok(tooLarge(rejection));
  assert.match(rejection!.message, /201 files.*200-file limit/);
});

test("a 10 MiB file is carried, one byte more is not", async () => {
  const read = await readRegistrySkillsFromArchive(
    zipball({
      "SKILL.md": SKILL_MD,
      "assets/video.bin": new Uint8Array(10 * MiB),
    }),
    source,
  );
  assert.equal(read.skills[0]?.rejection, undefined);
  assert.equal(
    read.skills[0]?.files.find((file) => file.bundlePath === "assets/video.bin")
      ?.sizeBytes,
    10 * MiB,
  );

  const rejection = await rejectionOf({
    "assets/video.bin": new Uint8Array(10 * MiB + 1),
  });
  assert.ok(tooLarge(rejection));
  assert.match(rejection!.message, /assets\/video\.bin.*10 MiB limit/);
});

test("files adding up past 50 MiB are refused", async () => {
  const chunk = new Uint8Array(9 * MiB);
  const rejection = await rejectionOf(
    Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [`assets/${index}.bin`, chunk]),
    ),
  );
  assert.ok(tooLarge(rejection));
  assert.match(rejection!.message, /in total.*50 MiB limit/);
});
