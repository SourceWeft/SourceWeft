import assert from "node:assert/strict";
import test from "node:test";
import {
  fileRelativePathSchema,
  fileSearchCoverageSchema,
  fileLocatorSchema,
} from "../src/files";

test("file paths cannot expand beyond an authorized root", () => {
  for (const path of [
    "/secret",
    "../secret",
    "a/../secret",
    "a//b",
    "a\\b",
    "a/./b",
    "a\0b",
  ]) {
    assert.equal(fileRelativePathSchema.safeParse(path).success, false, path);
  }
  assert.equal(
    fileRelativePathSchema.parse("reports/客户.pdf"),
    "reports/客户.pdf",
  );
});

test("partial search cannot claim complete coverage", () => {
  const complete = {
    status: "complete",
    visited: 1,
    matched: 0,
    skipped: 0,
    failed: 0,
    truncated: false,
    continuation: null,
  };
  assert.equal(fileSearchCoverageSchema.safeParse(complete).success, true);
  for (const extra of [
    { skipped: 1 },
    { failed: 1 },
    { truncated: true },
    { continuation: "next" },
  ]) {
    assert.equal(
      fileSearchCoverageSchema.safeParse({ ...complete, ...extra }).success,
      false,
    );
    assert.equal(
      fileSearchCoverageSchema.safeParse({
        ...complete,
        ...extra,
        status: "partial",
      }).success,
      true,
    );
  }
});

test("citations preserve locator type and reject reversed line ranges", () => {
  assert.equal(
    fileLocatorSchema.safeParse({ kind: "lines", start: 4, end: 2 }).success,
    false,
  );
  assert.deepEqual(
    fileLocatorSchema.parse({ kind: "cells", sheet: "Sales", range: "B2:C8" }),
    { kind: "cells", sheet: "Sales", range: "B2:C8" },
  );
});
