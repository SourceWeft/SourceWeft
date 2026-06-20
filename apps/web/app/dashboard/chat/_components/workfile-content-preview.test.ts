import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveWorkfileContentPreview } from "./workfile-content-preview";

test("resolveWorkfileContentPreview detects JavaScript files", () => {
  assert.deepEqual(
    resolveWorkfileContentPreview({
      contentText: "console.log('deck');\n",
      path: "/workfiles/ppt/deck.js",
    }),
    {
      contentText: "console.log('deck');\n",
      fileName: "deck.js",
      kind: "code",
      language: "javascript",
      lineCount: 2,
      path: "/workfiles/ppt/deck.js",
    },
  );
});

test("resolveWorkfileContentPreview detects TSX files", () => {
  const preview = resolveWorkfileContentPreview({
    contentText: "export function Deck() { return <div />; }",
    path: "/workfiles/ppt/deck.tsx",
  });

  assert.equal(preview.kind, "code");
  assert.equal(preview.language, "tsx");
});

test("resolveWorkfileContentPreview detects markdown by extension", () => {
  const preview = resolveWorkfileContentPreview({
    contentText: "# Deck",
    path: "/workfiles/ppt/README.md",
  });

  assert.equal(preview.kind, "markdown");
  assert.equal(preview.language, "markdown");
});

test("resolveWorkfileContentPreview detects markdown by mime type", () => {
  const preview = resolveWorkfileContentPreview({
    contentText: "# Deck",
    mimeType: "text/markdown; charset=utf-8",
    path: "/workfiles/ppt/README",
  });

  assert.equal(preview.kind, "markdown");
  assert.equal(preview.language, "markdown");
});

test("resolveWorkfileContentPreview falls unknown text back to log", () => {
  const preview = resolveWorkfileContentPreview({
    contentText: "plain text",
    path: "/workfiles/ppt/notes.txt",
  });

  assert.equal(preview.kind, "text");
  assert.equal(preview.language, "log");
});
