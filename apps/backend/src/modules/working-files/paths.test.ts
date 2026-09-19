import assert from "node:assert/strict";
import { test } from "vitest";
import {
  WORK_ROOT,
  basename,
  normalizeWorkingFilePath,
  normalizeWorkingFsPath,
  parentWorkingDirectory,
} from "./paths";

test("normalizeWorkingFilePath anchors relative paths under /files", () => {
  assert.equal(
    normalizeWorkingFilePath("notes/todo.md"),
    "/files/notes/todo.md",
  );
  assert.equal(
    normalizeWorkingFilePath("/files//notes///todo.md"),
    "/files/notes/todo.md",
  );
});

test("normalizeWorkingFilePath rejects roots and traversal", () => {
  assert.throws(() => normalizeWorkingFilePath(""), /path is required/);
  assert.throws(
    () => normalizeWorkingFilePath("/files"),
    /must point to a file/,
  );
  assert.throws(
    () => normalizeWorkingFilePath("/kb/source.md"),
    /only expose \/files/,
  );
  assert.throws(
    () => normalizeWorkingFilePath("/work/old.md"),
    /only expose \/files/,
  );
  assert.throws(
    () => normalizeWorkingFilePath("/files/../secret"),
    /invalid working file path/,
  );
  assert.throws(
    () => normalizeWorkingFilePath("~/secret"),
    /invalid working file path/,
  );
});

test("normalizeWorkingFsPath allows root and work directories", () => {
  assert.equal(normalizeWorkingFsPath(undefined), WORK_ROOT);
  assert.equal(normalizeWorkingFsPath("/"), "/");
  assert.equal(normalizeWorkingFsPath("/files/notes/"), "/files/notes");
});

test("working path helpers resolve parent and basename", () => {
  assert.equal(
    parentWorkingDirectory("/files/notes/todo.md"),
    "/files/notes",
  );
  assert.equal(parentWorkingDirectory("/files/todo.md"), "/files");
  assert.equal(basename("/files/notes/todo.md"), "todo.md");
});
