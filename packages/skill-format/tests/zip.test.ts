import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import { readSkillArchive, SkillArchiveError, sha256 } from "../src";

const ROOT = "repo-0123abcd";

function zipball(files: Record<string, string | Uint8Array>) {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    entries[name] = typeof content === "string" ? strToU8(content) : content;
  }
  return zipSync(entries);
}

function text(bytes: Uint8Array | undefined) {
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

describe("readSkillArchive", () => {
  const archive = zipball({
    [`${ROOT}/README.md`]: "repo readme",
    [`${ROOT}/skills/pdf/SKILL.md`]: "# pdf",
    [`${ROOT}/skills/pdf/scripts/run.py`]: "print(1)",
    [`${ROOT}/skills/other/SKILL.md`]: "# other",
  });

  it("strips the archive root and scopes to the subpath", () => {
    const files = readSkillArchive(archive, { subpath: "skills/pdf" });
    assert.deepEqual([...files.keys()].sort(), ["SKILL.md", "scripts/run.py"]);
    assert.equal(text(files.get("SKILL.md")), "# pdf");
  });

  it("reads a skill that sits at the repository root", () => {
    const files = readSkillArchive(archive, {
      subpath: "",
      keep: (path) => path === "README.md",
    });
    assert.deepEqual([...files.keys()], ["README.md"]);
  });

  it("does not let a sibling directory that shares a name prefix in", () => {
    const files = readSkillArchive(
      zipball({
        [`${ROOT}/skills/pdf/SKILL.md`]: "a",
        [`${ROOT}/skills/pdf-extra/SKILL.md`]: "b",
      }),
      { subpath: "skills/pdf" },
    );
    assert.equal(files.size, 1);
    assert.equal(text(files.get("SKILL.md")), "a");
  });

  it("returns only the manifest files when keep narrows the read", () => {
    const files = readSkillArchive(archive, {
      subpath: "skills/pdf",
      keep: (path) => path === "SKILL.md",
    });
    assert.deepEqual([...files.keys()], ["SKILL.md"]);
  });

  it("returns bytes whose hash is the recorded content hash", () => {
    const files = readSkillArchive(archive, { subpath: "skills/pdf" });
    assert.equal(sha256(files.get("SKILL.md")!), sha256("# pdf"));
  });

  it("refuses a kept entry whose path could escape", () => {
    for (const name of [
      `${ROOT}/skills/pdf/../../evil`,
      `${ROOT}/skills/pdf/a\\b`,
      `${ROOT}/skills/pdf/CON`,
    ]) {
      assert.throws(
        () =>
          readSkillArchive(zipball({ [name]: "x" }), { subpath: "skills/pdf" }),
        (error) =>
          error instanceof SkillArchiveError && error.code === "UNSAFE_PATH",
        name,
      );
    }
  });

  it("does not hold entries it never reads to the path rule", () => {
    const files = readSkillArchive(
      zipball({
        [`${ROOT}/skills/pdf/SKILL.md`]: "ok",
        [`${ROOT}/skills/pdf/a\\b`]: "ignored",
      }),
      { subpath: "skills/pdf", keep: (path) => path === "SKILL.md" },
    );
    assert.deepEqual([...files.keys()], ["SKILL.md"]);
  });

  it("refuses an unsafe subpath before reading anything", () => {
    assert.throws(
      () => readSkillArchive(archive, { subpath: "../x" }),
      (error) =>
        error instanceof SkillArchiveError && error.code === "UNSAFE_PATH",
    );
  });

  it("enforces the per-file, total and entry ceilings", () => {
    const big = zipball({
      [`${ROOT}/s/a`]: "x".repeat(100),
      [`${ROOT}/s/b`]: "y".repeat(100),
    });
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return error instanceof SkillArchiveError ? error.code : "other";
      }
      return "none";
    };
    assert.equal(
      code(() =>
        readSkillArchive(big, { subpath: "s", limits: { maxFileBytes: 50 } }),
      ),
      "ARCHIVE_TOO_LARGE",
    );
    assert.equal(
      code(() =>
        readSkillArchive(big, { subpath: "s", limits: { maxTotalBytes: 150 } }),
      ),
      "ARCHIVE_TOO_LARGE",
    );
    assert.equal(
      code(() =>
        readSkillArchive(big, { subpath: "s", limits: { maxEntries: 1 } }),
      ),
      "ARCHIVE_TOO_LARGE",
    );
  });

  it("does not count a rejected-by-keep entry against the byte ceilings", () => {
    const files = readSkillArchive(
      zipball({
        [`${ROOT}/s/SKILL.md`]: "ok",
        [`${ROOT}/s/huge.bin`]: "z".repeat(1000),
      }),
      {
        subpath: "s",
        keep: (path) => path === "SKILL.md",
        limits: { maxFileBytes: 50, maxTotalBytes: 50 },
      },
    );
    assert.equal(files.size, 1);
  });

  it("reports garbage as an invalid archive", () => {
    assert.throws(
      () => readSkillArchive(strToU8("not a zip")),
      (error) =>
        error instanceof SkillArchiveError && error.code === "ARCHIVE_INVALID",
    );
  });
});
