import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

// Configuration cases supply their own env; reloading config must not re-read
// a developer's .env and refill values deliberately absent in a test.
vi.mock("dotenv/config", () => ({}));

const toolCallRunLimitEnv = "SOURCEWEFT_AGENT_TOOL_CALL_RUN_LIMIT";
const toolCallThreadLimitEnv = "SOURCEWEFT_AGENT_TOOL_CALL_THREAD_LIMIT";
const originalRunLimit = process.env[toolCallRunLimitEnv];
const originalThreadLimit = process.env[toolCallThreadLimitEnv];
const originalMcpOrigins = process.env.MCP_ALLOWED_INTERNAL_ORIGINS;
const originalLlmOrigins = process.env.LLM_ALLOWED_INTERNAL_ORIGINS;
const originalDocumentParseProvider = process.env.DOCUMENT_PARSE_PROVIDER;
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
  vi.unstubAllEnvs();
  if (originalDocumentParseProvider === undefined)
    delete process.env.DOCUMENT_PARSE_PROVIDER;
  else process.env.DOCUMENT_PARSE_PROVIDER = originalDocumentParseProvider;
  if (originalLlmOrigins === undefined)
    delete process.env.LLM_ALLOWED_INTERNAL_ORIGINS;
  else process.env.LLM_ALLOWED_INTERNAL_ORIGINS = originalLlmOrigins;
  if (originalMcpOrigins === undefined)
    delete process.env.MCP_ALLOWED_INTERNAL_ORIGINS;
  else process.env.MCP_ALLOWED_INTERNAL_ORIGINS = originalMcpOrigins;
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

for (const nodeEnv of [
  "development",
  "production",
  "test",
  undefined,
  "",
  " ",
  "developement",
  "Development",
]) {
  test(`endpoint address checks only relax for explicit development: ${JSON.stringify(nodeEnv)}`, async () => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost/test");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("BETTER_AUTH_SECRET", "test-auth-secret-at-least-32-chars");
    vi.stubEnv(
      "MODEL_GATEWAY_ENCRYPTION_SECRET",
      "test-model-secret-at-least-32-chars",
    );
    vi.resetModules();
    const { config } = await import("./config");
    assert.equal(
      config.endpointAddressChecksEnabled,
      nodeEnv !== "development",
    );
  });
}

test("MCP internal origin configuration is parsed strictly at startup", async () => {
  process.env.MCP_ALLOWED_INTERNAL_ORIGINS =
    '["http://mcp.internal:8080","https://sso.internal"]';
  vi.resetModules();
  const { config } = await import("./config");
  assert.deepEqual(config.mcpAllowedInternalOrigins, [
    "http://mcp.internal:8080",
    "https://sso.internal",
  ]);
  process.env.MCP_ALLOWED_INTERNAL_ORIGINS = '["http://mcp.internal/path"]';
  vi.resetModules();
  await assert.rejects(import("./config"), /MCP_ALLOWED_INTERNAL_ORIGINS/);
});

test("LLM origins default empty and remain separate from MCP permissions", async () => {
  delete process.env.LLM_ALLOWED_INTERNAL_ORIGINS;
  process.env.MCP_ALLOWED_INTERNAL_ORIGINS = '["http://mcp.internal:8080"]';
  vi.resetModules();
  assert.deepEqual(
    (await import("./config")).config.llmAllowedInternalOrigins,
    [],
  );
  process.env.LLM_ALLOWED_INTERNAL_ORIGINS =
    '["http://model-service:8000","https://llm.internal"]';
  vi.resetModules();
  const { config } = await import("./config");
  assert.deepEqual(config.llmAllowedInternalOrigins, [
    "http://model-service:8000",
    "https://llm.internal",
  ]);
  assert.deepEqual(config.mcpAllowedInternalOrigins, [
    "http://mcp.internal:8080",
  ]);
  process.env.LLM_ALLOWED_INTERNAL_ORIGINS = '["http://model-service:8000/v1"]';
  vi.resetModules();
  await assert.rejects(import("./config"), /LLM_ALLOWED_INTERNAL_ORIGINS/);
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

for (const value of [undefined, "", "  \t\n"]) {
  test(`document provider defaults at configuration load for ${JSON.stringify(value)}`, async () => {
    if (value === undefined) delete process.env.DOCUMENT_PARSE_PROVIDER;
    else process.env.DOCUMENT_PARSE_PROVIDER = value;
    vi.resetModules();
    const { config } = await import("./config");
    assert.equal(config.documentParsing.provider, "pdf2markdown");
  });
}

for (const provider of [
  "langchain",
  "pdf2markdown",
  "docling",
  "llamaparse",
  "unstructured",
]) {
  test(`document provider keeps the existing ${provider} ID and normalizes case and whitespace`, async () => {
    process.env.DOCUMENT_PARSE_PROVIDER = `  ${provider.toUpperCase()}  `;
    vi.resetModules();
    const { config } = await import("./config");
    assert.equal(config.documentParsing.provider, provider);
  });
}

for (const value of [
  "pdf2markdwon",
  "vision",
  "pdf2markdown,langchain",
  "sensitive-value-not-to-echo",
]) {
  test(`unknown document provider ${value} rejects configuration loading`, async () => {
    process.env.DOCUMENT_PARSE_PROVIDER = value;
    vi.resetModules();
    await assert.rejects(import("./config"), (error) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /DOCUMENT_PARSE_PROVIDER must be one of: langchain, pdf2markdown, docling, llamaparse, unstructured/,
      );
      assert.equal(error.message.includes(value), false);
      return true;
    });
  });
}
