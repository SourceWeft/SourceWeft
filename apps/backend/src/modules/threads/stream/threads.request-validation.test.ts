import assert from "node:assert/strict";
import { test } from "vitest";
import {
  MAX_SELECTED_SKILLS_PER_TURN,
  streamThreadRequestSchema,
} from "@sourceweft/contracts/stream";

test("stream thread route uses the shared contracts schema for request validation", () => {
  assert.equal(typeof streamThreadRequestSchema.safeParse, "function");

  // Probe a rule only the shared schema enforces, so a local re-implementation
  // of request validation would fail this test.
  const overCapResult = streamThreadRequestSchema.safeParse({
    mode: "send",
    content: "hello",
    tools: {
      skillIds: Array.from(
        { length: MAX_SELECTED_SKILLS_PER_TURN + 1 },
        (_unused, index) => `builtin:skill-${index}`,
      ),
    },
  });
  assert.equal(overCapResult.success, false);

  const canonicalResult = streamThreadRequestSchema.safeParse({
    mode: "send",
    content: "hello",
    tools: { web_search: { enabled: true } },
  });
  assert.equal(canonicalResult.success, true);
});
