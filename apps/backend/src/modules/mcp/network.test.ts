import assert from "node:assert/strict";
import { test, vi } from "vitest";

vi.mock("../../shared/config", () => ({
  config: { endpointAddressChecksEnabled: true, mcpAllowedInternalOrigins: [] },
}));

import { McpError } from "./errors";
import { createMcpRequestScope, withMcpRequestDeadline } from "./network";

const timeoutError = () => new McpError(504, "MCP_OAUTH_TIMEOUT", "too slow");

test("the deadline aborts the signal handed to the work, which a late write must check", async () => {
  const requests = createMcpRequestScope();
  let sawSignal: AbortSignal | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let wrote = false;
  const result = withMcpRequestDeadline(
    requests,
    { ms: 30, timeoutError },
    async (_fetch, signal) => {
      sawSignal = signal;
      await gate; // a stalled step that does not observe the signal itself
      if (!signal.aborted) wrote = true;
    },
  );
  await assert.rejects(
    result,
    (error: unknown) => (error as McpError).code === "MCP_OAUTH_TIMEOUT",
  );
  assert.equal(sawSignal?.aborted, true);
  // The zombie finishes after the caller was told it timed out: it must not write.
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(wrote, false);
  await requests.close();
});

test("work that finishes in time returns its result and its signal stays live", async () => {
  const requests = createMcpRequestScope();
  let signal: AbortSignal | undefined;
  const value = await withMcpRequestDeadline(
    requests,
    { ms: 1_000, timeoutError },
    async (_fetch, given) => {
      signal = given;
      return 7;
    },
  );
  assert.equal(value, 7);
  assert.equal(signal?.aborted, false);
  await requests.close();
});
