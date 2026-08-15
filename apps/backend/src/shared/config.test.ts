import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

const toolCallRunLimitEnv = "SOURCEWEFT_AGENT_TOOL_CALL_RUN_LIMIT";
const toolCallThreadLimitEnv = "SOURCEWEFT_AGENT_TOOL_CALL_THREAD_LIMIT";
const originalRunLimit = process.env[toolCallRunLimitEnv];
const originalThreadLimit = process.env[toolCallThreadLimitEnv];
const interpreterEnvNames = [
  "SOURCEWEFT_AGENT_INTERPRETER_ENABLED",
  "SOURCEWEFT_AGENT_INTERPRETER_EXECUTION_TIMEOUT_MS",
  "SOURCEWEFT_AGENT_INTERPRETER_MEMORY_LIMIT_BYTES",
  "SOURCEWEFT_AGENT_INTERPRETER_MAX_STACK_SIZE_BYTES",
  "SOURCEWEFT_AGENT_INTERPRETER_MAX_RESULT_CHARS",
  "SOURCEWEFT_AGENT_INTERPRETER_MAX_PTC_CALLS_PER_EVAL",
  "SOURCEWEFT_AGENT_INTERPRETER_MAX_PTC_CALLS_PER_TURN",
  "SOURCEWEFT_AGENT_INTERPRETER_MAX_EVALS_PER_TURN",
  "SOURCEWEFT_AGENT_INTERPRETER_MAX_CONCURRENT_EVALS",
  "SOURCEWEFT_AGENT_INTERPRETER_MAX_CONCURRENT_PTC_PER_TURN",
  "SOURCEWEFT_AGENT_INTERPRETER_EVAL_QUEUE_TIMEOUT_MS",
  "SOURCEWEFT_AGENT_INTERPRETER_PTC_CALL_TIMEOUT_MS",
  "SOURCEWEFT_AGENT_INTERPRETER_MAX_CODE_CHARS",
] as const;
const originalInterpreterEnv = new Map(
  interpreterEnvNames.map((name) => [name, process.env[name]]),
);

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

  for (const name of interpreterEnvNames) {
    const original = originalInterpreterEnv.get(name);
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }

  vi.resetModules();
});

test("agent interpreter is disabled by default with strict limits", async () => {
  for (const name of interpreterEnvNames) delete process.env[name];
  vi.resetModules();

  const { config } = await import("./config");

  assert.equal(config.chat.agent.interpreter.enabled, false);
  assert.equal(config.chat.agent.interpreter.limits.executionTimeoutMs, 3_000);
  assert.equal(config.chat.agent.interpreter.limits.maxPtcCallsPerEval, 8);
  assert.equal(config.chat.agent.interpreter.limits.maxPtcCallsPerTurn, 24);
});

test("invalid explicit agent interpreter configuration fails startup", async () => {
  process.env.SOURCEWEFT_AGENT_INTERPRETER_ENABLED = "sometimes";
  vi.resetModules();

  await assert.rejects(
    import("./config"),
    /SOURCEWEFT_AGENT_INTERPRETER_ENABLED must be one of/,
  );
});

test("agent interpreter rejects an inconsistent turn budget", async () => {
  process.env.SOURCEWEFT_AGENT_INTERPRETER_MAX_PTC_CALLS_PER_EVAL = "8";
  process.env.SOURCEWEFT_AGENT_INTERPRETER_MAX_PTC_CALLS_PER_TURN = "4";
  vi.resetModules();

  await assert.rejects(
    import("./config"),
    /MAX_PTC_CALLS_PER_TURN must be greater than or equal to/,
  );
});

test("agent tool call limits are configurable via environment", async () => {
  process.env[toolCallRunLimitEnv] = "7";
  process.env[toolCallThreadLimitEnv] = "11";
  vi.resetModules();

  const { config } = await import("./config");

  assert.equal(config.chat.agent.toolCallRunLimit, 7);
  assert.equal(config.chat.agent.toolCallThreadLimit, 11);
});
