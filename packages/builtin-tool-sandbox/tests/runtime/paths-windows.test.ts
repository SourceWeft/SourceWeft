import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  assertCollectSandboxPath,
  assertExecuteCwd,
  assertPrepareSandboxPath,
  assertSandboxFilePath,
  assertSandboxReadPath,
  assertSandboxWritePath,
  dirname,
  isPathRootOrChild,
  normalizeSandboxPath,
} from "../../src/runtime/paths";
import type { SandboxProviderPathPolicy } from "../../src/runtime/types";

const ROOT = "C:/Users/Test/AppData/Roaming/app/task-workspaces/id/files";

const drivePolicy: SandboxProviderPathPolicy = {
  workspaceRoot: ROOT,
  defaultCwd: ROOT,
  prepareTargetRoots: [ROOT],
  collectSourceRoots: [ROOT],
  readWriteRoots: [ROOT],
};

const posixPolicy: SandboxProviderPathPolicy = {
  workspaceRoot: "/workspace",
  defaultCwd: "/workspace",
  prepareTargetRoots: ["/workspace/input", "/workspace"],
  collectSourceRoots: ["/workspace/output", "/workspace"],
  readWriteRoots: ["/workspace"],
};

/** The pre-Windows implementation, frozen: POSIX behaviour must not move. */
function legacyNormalizePath(value: string) {
  if (/[\x00-\x1f\x7f]/.test(value)) return value;
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return absolute.replace(/\/$/g, "") || "/";
}

function legacyIsRootOrChild(path: string, root: string) {
  const r = legacyNormalizePath(root);
  return path === r || path.startsWith(`${r}/`);
}

function legacyDirname(path: string) {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

const POSIX_INPUTS = [
  "",
  "/",
  "//",
  "///a//b/",
  "workspace",
  "workspace/",
  " /workspace/a ",
  "/workspace\\a\\b",
  "\\workspace\\a",
  "C:/Users/x",
  "C:\\Users\\x",
  "c:/",
  "C:",
  "C:foo",
  "/C:/x",
  "//server/share/x",
  "\\\\server\\share",
  "\\\\?\\C:\\x",
  "/a/../b",
  "~/x",
  "/workspace/a~1/b",
  "/work space/ü/日本",
  "/files/x",
  "a\u0000b",
  "/a\nb",
];

describe("POSIX path behaviour is byte-identical", () => {
  test("normalizeSandboxPath without drive awareness equals the legacy normaliser", () => {
    for (const input of POSIX_INPUTS) {
      assert.equal(
        normalizeSandboxPath(input, false),
        legacyNormalizePath(input),
        JSON.stringify(input),
      );
    }
  });

  test("a POSIX policy never turns a drive-looking input into a drive path", () => {
    for (const input of ["C:/Users/x", "C:\\Users\\x", "c:/", "C:foo"]) {
      assert.equal(
        normalizeSandboxPath(input, false),
        legacyNormalizePath(input),
      );
      assert.throws(
        () => assertSandboxReadPath(input, posixPolicy),
        (error: Error) =>
          error.message ===
          `SANDBOX_READ_PATH_DENIED: path must be under /workspace.`,
      );
    }
  });

  test("root matching and dirname equal the legacy functions for POSIX strings", () => {
    const paths = ["/workspace", "/workspace/a", "/workspaces", "/work", "/"];
    const roots = ["/workspace", "/workspace/", "workspace", "/", "/a b"];
    for (const path of paths) {
      for (const root of roots) {
        assert.equal(
          isPathRootOrChild(path, legacyNormalizePath(root)),
          legacyIsRootOrChild(path, root),
          `${path} in ${root}`,
        );
      }
      assert.equal(dirname(path), legacyDirname(path), path);
    }
  });

  test("the existing POSIX policy results are unchanged", () => {
    assert.equal(
      assertSandboxReadPath("/workspace/a/b.txt", posixPolicy),
      "/workspace/a/b.txt",
    );
    assert.equal(assertExecuteCwd(undefined, posixPolicy), "/workspace");
    assert.throws(
      () => assertSandboxReadPath("/workspace/a~/b", posixPolicy),
      /SANDBOX_READ_PATH_DENIED/,
    );
    assert.throws(
      () => assertSandboxReadPath("/workspace/RUNNER~1/b", posixPolicy),
      /SANDBOX_READ_PATH_DENIED/,
    );
  });
});

describe("drive-rooted policy", () => {
  test("normalizeSandboxPath is drive-aware only when asked", () => {
    assert.equal(normalizeSandboxPath("C:/Users/x/", true), "C:/Users/x");
    assert.equal(normalizeSandboxPath("c:\\Users\\x", true), "C:/Users/x");
    assert.equal(normalizeSandboxPath("C://Users//x", true), "C:/Users/x");
    assert.equal(normalizeSandboxPath(" d:/a ", true), "D:/a");
    assert.equal(normalizeSandboxPath("C:", true), "C:/");
    assert.equal(normalizeSandboxPath("C:/", true), "C:/");
    // The virtual root and POSIX-style paths keep their meaning.
    assert.equal(normalizeSandboxPath("/", true), "/");
    assert.equal(normalizeSandboxPath("/workspace", true), "/workspace");
    // Not drive-absolute: stays a (rejectable) rooted path.
    assert.equal(normalizeSandboxPath("C:foo", true), "/C:foo");
    assert.equal(normalizeSandboxPath("\\\\?\\C:\\x", true), "/?/C:/x");
    assert.equal(normalizeSandboxPath("\\\\srv\\share", true), "/srv/share");
  });

  test("the default cwd and children are accepted", () => {
    assert.equal(assertExecuteCwd(undefined, drivePolicy), ROOT);
    assert.equal(assertExecuteCwd(`${ROOT}/sub`, drivePolicy), `${ROOT}/sub`);
    assert.equal(
      assertExecuteCwd(`${ROOT.replace(/\//g, "\\")}\\sub`, drivePolicy),
      `${ROOT}/sub`,
    );
  });

  test("read, write, prepare, collect and file paths accept the workspace subtree", () => {
    const file = `${ROOT}/src/index.ts`;
    assert.equal(assertSandboxReadPath(file, drivePolicy), file);
    assert.equal(assertSandboxWritePath(file, drivePolicy), file);
    assert.equal(assertSandboxFilePath(file, drivePolicy), file);
    assert.equal(assertPrepareSandboxPath(file, drivePolicy), file);
    assert.equal(assertCollectSandboxPath(file, drivePolicy), file);
  });

  test("drive letter and directory case follow NTFS and are normalised", () => {
    assert.equal(
      assertSandboxReadPath(ROOT.toLowerCase() + "/A.txt", drivePolicy),
      ROOT.toLowerCase().replace(/^c/, "C") + "/A.txt",
    );
    assert.equal(assertExecuteCwd(ROOT.replace("C:", "c:"), drivePolicy), ROOT);
  });

  test("sibling, parent, other-drive and rooted paths are denied", () => {
    for (const bad of [
      `${ROOT}-evil/a`,
      `${ROOT}x`,
      "C:/Users/Test/AppData/Roaming/app/task-workspaces/id",
      "C:/Users/Test/.ssh/id_rsa",
      "D:/Users/Test/AppData/Roaming/app/task-workspaces/id/files/a",
      "/Users/Test/AppData/Roaming/app/task-workspaces/id/files/a",
      `${ROOT}/../other`,
      "C:/",
      "C:foo",
      "\\\\server\\share\\x",
      "\\\\?\\C:\\Users\\Test",
    ]) {
      assert.throws(
        () => assertSandboxReadPath(bad, drivePolicy),
        /SANDBOX_READ_PATH_DENIED/,
        bad,
      );
    }
    assert.throws(
      () => assertExecuteCwd("C:/Windows", drivePolicy),
      /SANDBOX_EXECUTE_CWD_DENIED/,
    );
  });

  test("home expansion is refused but an 8.3 short name is an ordinary component", () => {
    assert.equal(
      assertSandboxReadPath(`${ROOT}/RUNNER~1/a`, drivePolicy),
      `${ROOT}/RUNNER~1/a`,
    );
    assert.throws(
      () => assertSandboxReadPath(`${ROOT}/~root/a`, drivePolicy),
      /SANDBOX_READ_PATH_DENIED/,
    );
    assert.throws(
      () => assertSandboxReadPath(`${ROOT}/~`, drivePolicy),
      /SANDBOX_READ_PATH_DENIED/,
    );
  });

  test("virtual SourceWeft roots stay refused", () => {
    assert.throws(
      () => assertSandboxReadPath("/files/a", drivePolicy),
      /SANDBOX_READ_PATH_DENIED/,
    );
  });

  test("the error text names the drive root", () => {
    assert.throws(
      () => assertSandboxReadPath("C:/elsewhere", drivePolicy),
      (error: Error) =>
        error.message ===
        `SANDBOX_READ_PATH_DENIED: path must be under ${ROOT}.`,
    );
  });

  test("isPathRootOrChild compares drive roots case-insensitively with a boundary", () => {
    assert.equal(isPathRootOrChild("C:/a/b", "c:/A"), true);
    assert.equal(isPathRootOrChild("C:/a", "C:/a"), true);
    assert.equal(isPathRootOrChild("C:/ab", "C:/a"), false);
    assert.equal(isPathRootOrChild("D:/a", "C:/a"), false);
    assert.equal(isPathRootOrChild("C:/A/b", "C:/"), true);
    assert.equal(isPathRootOrChild("/a/B", "/a"), true);
    assert.equal(isPathRootOrChild("/A/B", "/a"), false);
  });

  test("dirname keeps the drive", () => {
    assert.equal(dirname("C:/a/b.txt"), "C:/a");
    assert.equal(dirname("C:/a"), "C:/");
    assert.equal(dirname("C:/"), "C:/");
    assert.equal(dirname("/a/b"), "/a");
    assert.equal(dirname("/a"), "/");
  });
});
