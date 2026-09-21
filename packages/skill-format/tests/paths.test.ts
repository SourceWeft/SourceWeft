import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findCaseCollisions,
  isAgentSkillName,
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

  it("rejects every reserved device name, with or without an extension", () => {
    const names = [
      "con",
      "prn",
      "aux",
      "nul",
      ...Array.from({ length: 10 }, (_, i) => `com${i}`),
      ...Array.from({ length: 10 }, (_, i) => `lpt${i}`),
      "com\u00b9",
      "com\u00b2",
      "com\u00b3",
      "lpt\u00b9",
      "lpt\u00b2",
      "lpt\u00b3",
      "conin$",
      "conout$",
    ];
    for (const name of names) {
      for (const variant of [
        name,
        name.toUpperCase(),
        `${name}.txt`,
        `${name}.tar.gz`,
        `${name} .txt`,
        `dir/${name}`,
        `dir/${name}.md`,
      ]) {
        assert.equal(isSafeBundlePath(variant, "win32"), false, variant);
      }
    }
  });

  it("keeps names that merely contain or resemble a reserved one", () => {
    for (const path of [
      "console.md",
      "auxiliary.md",
      "nully",
      "com10.md",
      "com.md",
      "lpt.txt",
      "com\u2074.md",
      "prn-notes.md",
      "a.con",
    ]) {
      assert.equal(isSafeBundlePath(path, "win32"), true, path);
    }
    // A reserved name is refused as a directory too, not only as a file.
    assert.equal(isSafeBundlePath("scripts/aux/run.sh", "win32"), false);
  });

  it("rejects NTFS alternate data streams and drive-relative segments", () => {
    for (const path of [
      "SKILL.md:hidden",
      "SKILL.md::$DATA",
      "scripts/run.sh:stream:$DATA",
      "a/C:x",
      "a/c:/x",
      ":x",
      "x:",
    ]) {
      assert.equal(isSafeBundlePath(path, "win32"), false, path);
    }
  });

  it("rejects the other characters Windows cannot put in a name", () => {
    for (const char of ["<", ">", '"', "|", "?", "*"]) {
      assert.equal(isSafeBundlePath(`a${char}b.md`, "win32"), false, char);
      assert.equal(isSafeBundlePath(`dir/${char}`, "win32"), false, char);
    }
  });

  it("rejects Win32 and NT namespace prefixes", () => {
    for (const path of [
      "\\\\?\\C:\\x",
      "\\\\.\\pipe\\x",
      "\\??\\C:\\x",
      "//?/C:/x",
      "//./nul",
      "//server/share/x",
    ]) {
      assert.equal(isSafeBundlePath(path, "win32"), false, path);
    }
  });

  it("still accepts characters that are fine everywhere", () => {
    for (const path of [
      "a b/c d.md",
      "notes (1).md",
      "a-b_c+d=e,f;g@h#i%j&k.md",
      "\u00e9t\u00e9/\u65e5\u672c\u8a9e.md",
      "a.b/c.d",
      ".claude/x",
      "$x/y",
    ]) {
      assert.equal(isSafeBundlePath(path, "win32"), true, path);
    }
  });

  it("keeps every name that installs on macOS and Linux installing there", () => {
    // What only Windows refuses is enforced only when writing on Windows.
    for (const path of [
      "notes/a:b.md",
      "what?.md",
      "a*b",
      'q"x.md',
      "a<b>|c.md",
      "com0.md",
      "lpt0",
      "com\u00b9.md",
      "conin$",
      "nul .txt",
      "a/x:",
    ]) {
      assert.equal(isSafeBundlePath(path, "linux"), true, path);
      assert.equal(isSafeBundlePath(path, "darwin"), true, path);
    }
  });

  it("refuses the portable baseline on every platform", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      for (const path of [
        "C:x",
        "c:/x",
        "con",
        "nul.txt",
        "com1.md",
        "lpt9",
        "a/aux/b",
        "a/b.",
        "a/b ",
        "../x",
        "/x",
        "a\\b",
      ]) {
        assert.equal(
          isSafeBundlePath(path, platform),
          false,
          `${platform} ${path}`,
        );
      }
    }
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

describe("isAgentSkillName", () => {
  it("accepts the specification's names", () => {
    for (const name of [
      "pdf",
      "test-driven-development",
      "a",
      "x1-y2",
      "a".repeat(64),
    ]) {
      assert.equal(isAgentSkillName(name), true, name);
    }
  });

  it("refuses edge hyphens, doubled hyphens, capitals and overlong names", () => {
    for (const name of [
      "-pdf",
      "pdf-",
      "pdf--forms",
      "PDF",
      "pdf forms",
      "",
      "a".repeat(65),
    ]) {
      assert.equal(isAgentSkillName(name), false, name);
    }
  });

  it("every name it accepts is also a safe directory name", () => {
    for (const name of ["pdf", "test-driven-development", "a".repeat(64)]) {
      assert.equal(isSafeSkillDirName(name), true, name);
    }
  });
});
