import assert from "node:assert/strict";
import { test } from "vitest";
import { streamThreadRequestSchema } from "@sourceweft/contracts/content";

test("stream thread route uses the shared contracts schema for request validation", () => {
  assert.equal(typeof streamThreadRequestSchema.safeParse, "function");

  const legacyResult = streamThreadRequestSchema.safeParse({
    mode: "send",
    content: "hello",
    tools: { webSearchEnabled: true },
  });
  assert.equal(legacyResult.success, false);

  const canonicalResult = streamThreadRequestSchema.safeParse({
    mode: "send",
    content: "hello",
    tools: { web_search: { enabled: true } },
  });
  assert.equal(canonicalResult.success, true);
});
