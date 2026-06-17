import assert from "node:assert/strict";
import { test } from "vitest";
import {
  WORK_ROOT,
  basename,
  normalizeWorkingFilePath,
  normalizeWorkingFsPath,
  parentWorkingDirectory,
} from "./paths";

test("normalizeWorkingFilePath anchors relative paths under /workfiles", () => {
  assert.equal(
    normalizeWorkingFilePath("notes/todo.md"),
    "/workfiles/notes/todo.md",
  );
  assert.equal(
    normalizeWorkingFilePath("/workfiles//notes///todo.md"),
    "/workfiles/notes/todo.md",
  );
});

test("normalizeWorkingFilePath rejects roots and traversal", () => {
  assert.throws(() => normalizeWorkingFilePath(""), /path is required/);
  assert.throws(
    () => normalizeWorkingFilePath("/workfiles"),
    /must point to a file/,
  );
  assert.throws(
    () => normalizeWorkingFilePath("/kb/source.md"),
    /only expose \/workfiles/,
  );
  assert.throws(
    () => normalizeWorkingFilePath("/work/old.md"),
    /only expose \/workfiles/,
  );
  assert.throws(
    () => normalizeWorkingFilePath("/workfiles/../secret"),
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
  assert.equal(normalizeWorkingFsPath("/workfiles/notes/"), "/workfiles/notes");
});

test("working path helpers resolve parent and basename", () => {
  assert.equal(
    parentWorkingDirectory("/workfiles/notes/todo.md"),
    "/workfiles/notes",
  );
  assert.equal(parentWorkingDirectory("/workfiles/todo.md"), "/workfiles");
  assert.equal(basename("/workfiles/notes/todo.md"), "todo.md");
});
