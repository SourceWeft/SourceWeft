import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { beforeEach, test, vi } from "vitest";

/**
 * What the read stage makes of a real zipball: every bundle file is carried as
 * bytes — binary ones included — and a skill over a storage limit is refused
 * whole. The limits are shrunk so the fixtures stay a few KiB; the code under
 * test reads them from `SKILL_STORAGE_LIMITS` either way.
 */
const LIMITS = vi.hoisted(() => ({
  maxFiles: 4,
  maxFileBytes: 1024,
  maxBundleBytes: 2048,
}));
vi.mock("../storage", () => ({ SKILL_STORAGE_LIMITS: LIMITS }));

// Lets one test make the archive under-declare its sizes, as a hostile one can.
const lie = vi.hoisted(() => ({ declaredSize: null as number | null }));
vi.mock("../../market/parser/github-zip", async (original) => {
  const actual =
    await original<typeof import("../../market/parser/github-zip")>();
  return {
    ...actual,
    listZipEntries: async (zip: Buffer) =>
      (await actual.listZipEntries(zip)).map((entry) => ({
        ...entry,
        declaredSize: lie.declaredSize ?? entry.declaredSize,
      })),
  };
});

import { RegistrySubmissionError } from "./errors";
import { readRegistrySkillsFromArchive } from "./read";

const source = {
  owner: "acme",
  repo: "skills",
  subpath: "",
  repoUrl: "https://github.com/acme/skills",
  sourceUrl: "https://github.com/acme/skills",
  commitSha: "a".repeat(40),
  committedAt: "2026-02-01T10:00:00.000Z",
};

const SKILL_MD = "---\nname: poster\ndescription: Posters\n---\nBody\n";
// Not valid UTF-8, so neither can be carried as text.
const TTF = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0xff, 0xfe, 0x00]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A GitHub-shaped zipball: everything under one `<repo>-<sha>/` root. */
function zipball(files: Record<string, string | Uint8Array>) {
  return Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(files).map(([path, content]) => [
          `skills-abc/${path}`,
          typeof content === "string" ? strToU8(content) : content,
        ]),
      ),
    ),
  );
}

const tooLarge = (error: unknown) =>
  error instanceof RegistrySubmissionError &&
  error.code === "REGISTRY_SUBMISSION_TOO_LARGE";

beforeEach(() => {
  lie.declaredSize = null;
});

test("binary files are part of the bundle, byte for byte, next to the text", async () => {
  const read = await readRegistrySkillsFromArchive(
    zipball({
      "skills/poster/SKILL.md": SKILL_MD,
      "skills/poster/fonts/Inter.ttf": TTF,
      "skills/poster/assets/cover.png": PNG,
    }),
    source,
  );
  const [skill] = read.skills;
  assert.equal(skill?.rejection, undefined);
  assert.deepEqual(
    skill?.files.map((file) => [file.bundlePath, file.isText, file.mimeType]),
    [
      ["assets/cover.png", false, "image/png"],
      ["fonts/Inter.ttf", false, "font/ttf"],
      ["SKILL.md", true, "text/markdown"],
    ],
  );
  const font = skill!.files.find((file) => file.bundlePath.endsWith(".ttf"))!;
  assert.deepEqual(new Uint8Array(font.bytes), TTF);
  assert.equal(font.sizeBytes, TTF.byteLength);
  assert.equal(font.contentText, null);
  const skillMd = skill!.files.find((file) => file.bundlePath === "SKILL.md")!;
  assert.equal(skillMd.contentText, SKILL_MD);
  assert.equal(Buffer.from(skillMd.bytes).toString("utf8"), SKILL_MD);
  assert.equal(read.committedAt, source.committedAt);
});

test("a skill with too many files is refused, not truncated", async () => {
  const files: Record<string, string> = { "SKILL.md": SKILL_MD };
  for (let index = 0; index < LIMITS.maxFiles; index += 1) {
    files[`references/${index}.md`] = "note";
  }
  const read = await readRegistrySkillsFromArchive(zipball(files), source);
  assert.ok(tooLarge(read.skills[0]?.rejection));
  assert.match(read.skills[0]!.rejection!.message, /5 files.*4-file limit/);
  assert.deepEqual(read.skills[0]?.files, []);
});

test("a skill with one file over the per-file limit is refused", async () => {
  const read = await readRegistrySkillsFromArchive(
    zipball({
      "SKILL.md": SKILL_MD,
      "assets/huge.bin": new Uint8Array(LIMITS.maxFileBytes + 1),
    }),
    source,
  );
  assert.ok(tooLarge(read.skills[0]?.rejection));
  assert.match(read.skills[0]!.rejection!.message, /assets\/huge\.bin/);
  assert.deepEqual(read.skills[0]?.files, []);
});

test("a skill whose files add up past the bundle limit is refused", async () => {
  const read = await readRegistrySkillsFromArchive(
    zipball({
      "SKILL.md": SKILL_MD,
      "assets/a.bin": new Uint8Array(LIMITS.maxFileBytes),
      "assets/b.bin": new Uint8Array(LIMITS.maxFileBytes),
    }),
    source,
  );
  assert.ok(tooLarge(read.skills[0]?.rejection));
  assert.match(read.skills[0]!.rejection!.message, /in total/);
});

test("one oversized skill does not cost the repository its other skills", async () => {
  const read = await readRegistrySkillsFromArchive(
    zipball({
      "skills/big/SKILL.md": SKILL_MD,
      "skills/big/huge.bin": new Uint8Array(LIMITS.maxFileBytes + 1),
      "skills/small/SKILL.md": SKILL_MD,
      "skills/small/fonts/Inter.ttf": TTF,
    }),
    source,
  );
  const byDir = new Map(read.skills.map((skill) => [skill.dirName, skill]));
  assert.ok(tooLarge(byDir.get("big")?.rejection));
  assert.equal(byDir.get("small")?.rejection, undefined);
  assert.deepEqual(
    byDir.get("small")?.files.map((file) => file.bundlePath),
    ["fonts/Inter.ttf", "SKILL.md"],
  );
});

test("a nested skill's files count against it, not the skill above", async () => {
  const files: Record<string, string> = {
    "SKILL.md": SKILL_MD,
    "skills/inner/SKILL.md": SKILL_MD,
  };
  for (let index = 0; index < LIMITS.maxFiles - 1; index += 1) {
    files[`skills/inner/references/${index}.md`] = "note";
  }
  const read = await readRegistrySkillsFromArchive(zipball(files), source);
  const byDir = new Map(read.skills.map((skill) => [skill.repoSubpath, skill]));
  assert.deepEqual(
    byDir.get("")?.files.map((file) => file.bundlePath),
    ["SKILL.md"],
  );
  assert.equal(byDir.get("skills/inner")?.files.length, LIMITS.maxFiles);
});

test("an archive that under-declares its sizes is caught on the actual bytes", async () => {
  lie.declaredSize = 1;
  const read = await readRegistrySkillsFromArchive(
    zipball({
      "SKILL.md": SKILL_MD,
      "assets/a.bin": new Uint8Array(LIMITS.maxFileBytes),
      "assets/b.bin": new Uint8Array(LIMITS.maxFileBytes),
    }),
    source,
  );
  assert.ok(tooLarge(read.skills[0]?.rejection));
  assert.deepEqual(read.skills[0]?.files, []);
});

test("a source without a commit date is refused", async () => {
  await assert.rejects(
    readRegistrySkillsFromArchive(zipball({ "SKILL.md": SKILL_MD }), {
      ...source,
      committedAt: undefined,
    }),
    (error) =>
      error instanceof RegistrySubmissionError &&
      error.code === "REGISTRY_SUBMISSION_UNDATED",
  );
});
