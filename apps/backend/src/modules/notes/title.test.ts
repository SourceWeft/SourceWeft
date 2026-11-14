import assert from "node:assert/strict";
import { test } from "vitest";
import { noteTitle } from "./service";

test("a heading becomes the title", () => {
  assert.equal(noteTitle("# Revenue\n\nRevenue grew."), "Revenue");
});

test("the first sentence is used, without its citation marker or stray space", () => {
  assert.equal(
    noteTitle(
      "Revenue grew 23% to $4.1 billion in fiscal 2025 [citation:c1]. The company also opened a new office [citation:c1].",
    ),
    "Revenue grew 23% to $4.1 billion in fiscal 2025",
  );
});

test("a long first sentence is cut at a word boundary", () => {
  const title = noteTitle(
    "This is a very long opening sentence that keeps going well past the limit for a note title so it must be cut.",
  );
  assert.ok(title.endsWith("…"));
  assert.ok(title.length <= 81);
  assert.equal(title.includes("  "), false);
});

test("an empty answer gets a fallback title", () => {
  assert.equal(noteTitle("  \n "), "Saved answer");
});
