import assert from "node:assert/strict";
import { test } from "vitest";
import { formatRetrievalContext } from "./retrieval-tool";

test("formatRetrievalContext tells the model not to infer unsupported values", () => {
  const context = formatRetrievalContext([
    {
      citation: "c1",
      chunkId: "chunk-1",
      sourceTitle: "Source",
      content: "Generic instructions that describe what may happen.",
    },
  ]);

  assert.match(context, /does not directly support/);
  assert.match(context, /Do not infer a concrete answer/);
});

test("formatRetrievalContext returns no-evidence guidance for empty results", () => {
  const context = formatRetrievalContext([]);

  assert.match(context, /No relevant evidence was found/);
});
