import assert from "node:assert/strict";
import { test } from "vitest";
import {
  WORK_ROOT,
  basename,
  normalizeWorkingFilePath,
  normalizeWorkingFsPath,
  parentWorkingDirectory,
} from "./paths";

test("normalizeWorkingFilePath anchors relative paths under /work", () => {
  assert.equal(
    normalizeWorkingFilePath("notes/todo.md"),
    "/work/notes/todo.md",
  );
  assert.equal(
    normalizeWorkingFilePath("/work//notes///todo.md"),
    "/work/notes/todo.md",
  );
});

test("normalizeWorkingFilePath rejects roots and traversal", () => {
  assert.throws(() => normalizeWorkingFilePath(""), /path is required/);
  assert.throws(
    () => normalizeWorkingFilePath("/work"),
    /must point to a file/,
  );
  assert.throws(
    () => normalizeWorkingFilePath("/kb/source.md"),
    /only expose \/work/,
  );
  assert.throws(
    () => normalizeWorkingFilePath("/work/../secret"),
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
  assert.equal(normalizeWorkingFsPath("/work/notes/"), "/work/notes");
});

test("working path helpers resolve parent and basename", () => {
  assert.equal(parentWorkingDirectory("/work/notes/todo.md"), "/work/notes");
  assert.equal(parentWorkingDirectory("/work/todo.md"), "/work");
  assert.equal(basename("/work/notes/todo.md"), "todo.md");
});
