import assert from "node:assert/strict";
import { test } from "vitest";
import {
  resolveRecursiveSourceDeleteOrder,
  shouldRejectSingleSourceDelete,
} from "./service";

test("resolveRecursiveSourceDeleteOrder deletes directory descendants before the directory", () => {
  const order = resolveRecursiveSourceDeleteOrder({
    requestedSourceIds: ["dir-root"],
    selectedSources: [
      { id: "dir-root", parentSourceId: null, sourceType: "directory" },
    ],
    descendants: [
      { id: "file-a", parentSourceId: "dir-root" },
      { id: "dir-child", parentSourceId: "dir-root" },
      { id: "file-b", parentSourceId: "dir-child" },
    ],
  });

  assert.deepEqual(order, ["file-a", "file-b", "dir-child", "dir-root"]);
});

test("resolveRecursiveSourceDeleteOrder deduplicates children covered by a selected ancestor", () => {
  const order = resolveRecursiveSourceDeleteOrder({
    requestedSourceIds: ["dir-root", "file-a", "dir-child"],
    selectedSources: [
      { id: "dir-root", parentSourceId: null, sourceType: "directory" },
      { id: "file-a", parentSourceId: "dir-root", sourceType: "manual_upload" },
      { id: "dir-child", parentSourceId: "dir-root", sourceType: "directory" },
    ],
    descendants: [
      { id: "file-a", parentSourceId: "dir-root" },
      { id: "dir-child", parentSourceId: "dir-root" },
      { id: "file-b", parentSourceId: "dir-child" },
    ],
  });

  assert.deepEqual(order, ["file-a", "file-b", "dir-child", "dir-root"]);
});

test("shouldRejectSingleSourceDelete preserves non-empty directory protection", () => {
  assert.equal(
    shouldRejectSingleSourceDelete({
      sourceType: "directory",
      hasChildren: true,
    }),
    true,
  );
  assert.equal(
    shouldRejectSingleSourceDelete({
      sourceType: "directory",
      hasChildren: false,
    }),
    false,
  );
  assert.equal(
    shouldRejectSingleSourceDelete({
      sourceType: "manual_upload",
      hasChildren: true,
    }),
    false,
  );
});
