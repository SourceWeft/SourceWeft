import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findCaseCollisions,
  isSafeBundlePath,
  isSafeSkillDirName,
} from "../src";

describe("isSafeBundlePath", () => {
  it("accepts ordinary nested relative paths", () => {
    for (const path of [
      "SKILL.md",
      "scripts/run.py",
      "assets/fonts/Inter-Bold.ttf",
      "a/b/c.d.e",
      ".hidden/file",
    ]) {
      assert.equal(isSafeBundlePath(path), true, path);
    }
  });

  it("rejects everything that could resolve outside the target", () => {
    for (const path of [
      "",
      "/etc/passwd",
      "../x",
      "a/../x",
      "a/./b",
      ".",
      "..",
      "a//b",
      "a/",
      "a\\b",
      "..\\x",
      "C:/x",
      "c:x",
      "a/b\0c",
      "a/\x1fb",
      "a/\x7f",
    ]) {
      assert.equal(isSafeBundlePath(path), false, JSON.stringify(path));
    }
  });

  it("rejects names Windows strips or reserves", () => {
    for (const path of [
      "a/b.",
      "a/b ",
      "CON",
      "dir/nul.txt",
      "COM1.md",
      "lpt9",
    ]) {
      assert.equal(isSafeBundlePath(path), false, path);
    }
    assert.equal(isSafeBundlePath("console.md"), true);
  });
});

describe("isSafeSkillDirName", () => {
  it("accepts registry-style names", () => {
    for (const name of [
      "a",
      "pdf",
      "brand-guidelines",
      "a1-b2",
      "x".repeat(64),
    ]) {
      assert.equal(isSafeSkillDirName(name), true, name);
    }
  });

  it("rejects flag-like, traversing, over-long and non-lowercase names", () => {
    for (const name of [
      "",
      "-rf",
      "..",
      "a/b",
      "A",
      "a_b",
      "a b",
      "x".repeat(65),
      "con",
      "nul",
    ]) {
      assert.equal(isSafeSkillDirName(name), false, name);
    }
  });
});

describe("findCaseCollisions", () => {
  it("reports paths that share a file on a case-insensitive filesystem", () => {
    assert.deepEqual(findCaseCollisions(["a/B.md", "a/b.md", "c.md"]), [
      ["a/B.md", "a/b.md"],
    ]);
  });

  it("treats canonically-equivalent unicode as the same file", () => {
    assert.equal(findCaseCollisions(["é.md", "e\u0301.md"]).length, 1);
  });

  it("finds nothing in a clean set, and ignores a repeated identical path", () => {
    assert.deepEqual(findCaseCollisions(["a", "b", "a"]), []);
  });
});
