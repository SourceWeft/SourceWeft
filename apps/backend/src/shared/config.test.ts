import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

const toolCallRunLimitEnv = "SOURCEWEFT_AGENT_TOOL_CALL_RUN_LIMIT";
const toolCallThreadLimitEnv = "SOURCEWEFT_AGENT_TOOL_CALL_THREAD_LIMIT";
const originalRunLimit = process.env[toolCallRunLimitEnv];
const originalThreadLimit = process.env[toolCallThreadLimitEnv];

afterEach(() => {
  if (originalRunLimit === undefined) {
    delete process.env[toolCallRunLimitEnv];
  } else {
    process.env[toolCallRunLimitEnv] = originalRunLimit;
  }

  if (originalThreadLimit === undefined) {
    delete process.env[toolCallThreadLimitEnv];
  } else {
    process.env[toolCallThreadLimitEnv] = originalThreadLimit;
  }

  vi.resetModules();
});

test("agent tool call limits are configurable via environment", async () => {
  process.env[toolCallRunLimitEnv] = "7";
  process.env[toolCallThreadLimitEnv] = "11";
  vi.resetModules();

  const { config } = await import("./config");

  assert.equal(config.chat.agent.toolCallRunLimit, 7);
  assert.equal(config.chat.agent.toolCallThreadLimit, 11);
});
