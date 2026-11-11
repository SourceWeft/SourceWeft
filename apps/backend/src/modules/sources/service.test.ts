import assert from "node:assert/strict";
import { test } from "vitest";
import {
  assertWebSourceUrlSupported,
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

for (const url of [
  "https://youtu.be/jNQXAC9IVRw",
  "https://youtu.be/jNQXAC9IVRw?si=abc",
  "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  "https://youtube.com/playlist?list=PL123",
  "https://m.youtube.com/watch?v=jNQXAC9IVRw",
  "https://music.youtube.com/watch?v=jNQXAC9IVRw",
  "https://www.youtube-nocookie.com/embed/jNQXAC9IVRw",
  "https://YOUTU.BE./jNQXAC9IVRw",
]) {
  test(`assertWebSourceUrlSupported rejects the YouTube link ${url}`, () => {
    assert.throws(
      () => assertWebSourceUrlSupported(url),
      (error: unknown) => {
        assert.equal(
          (error as { code?: string }).code,
          "WEB_SOURCE_YOUTUBE_UNSUPPORTED",
        );
        assert.equal((error as { statusCode?: number }).statusCode, 422);
        return true;
      },
    );
  });
}

for (const url of [
  "https://example.com/article",
  "https://notyoutube.com/watch?v=1",
  "https://youtube.com.example.org/watch?v=1",
  "https://example.com/?next=https://youtu.be/jNQXAC9IVRw",
  "https://myyoutu.be/abc",
]) {
  test(`assertWebSourceUrlSupported accepts ${url}`, () => {
    assert.doesNotThrow(() => assertWebSourceUrlSupported(url));
  });
}
