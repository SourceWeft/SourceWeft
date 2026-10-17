import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";

// Configuration cases supply their own env; reloading config must not re-read
// a developer's .env and refill values deliberately absent in a test.
vi.mock("dotenv/config", () => ({}));

const closingStepsEnv = "SOURCEWEFT_AGENT_CLOSING_STEPS";
const maxStepsEnv = "SOURCEWEFT_AGENT_MAX_STEPS";
const retiredToolLimitEnvs = [
  "SOURCEWEFT_AGENT_TOOL_CALL_RUN_LIMIT",
  "SOURCEWEFT_AGENT_TOOL_CALL_THREAD_LIMIT",
] as const;
const agentBudgetEnvNames = [
  maxStepsEnv,
  closingStepsEnv,
  ...retiredToolLimitEnvs,
];
const originalAgentBudgetEnv = new Map(
  agentBudgetEnvNames.map((name) => [name, process.env[name]]),
);

// Every configuration test starts without ambient budget settings. Individual
// migration/override cases explicitly install only the values they exercise.
beforeEach(() => {
  for (const name of agentBudgetEnvNames) delete process.env[name];
});
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
  for (const name of agentBudgetEnvNames) {
    const original = originalAgentBudgetEnv.get(name);
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
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

test("agent runs default to 400 model-decision steps, without legacy tool-count fields", async () => {
  vi.resetModules();
  const { config } = await import("./config");
  assert.equal(config.chat.agent.maxSteps, 400);
  assert.equal(config.chat.agent.closingSteps, 40);
  assert.equal("toolCallRunLimit" in config.chat.agent, false);
  assert.equal("toolCallThreadLimit" in config.chat.agent, false);
});

for (const [raw, expected] of [
  ["1", 1],
  ["400", 400],
  [" 25 ", 25],
  [String(Number.MAX_SAFE_INTEGER - 40), Number.MAX_SAFE_INTEGER - 40],
] as const) {
  test(`agent max steps accepts an explicit positive decimal safe integer: ${JSON.stringify(raw)}`, async () => {
    process.env[maxStepsEnv] = raw;
    vi.resetModules();
    assert.equal(
      (await import("./config")).config.chat.agent.maxSteps,
      expected,
    );
  });
}

for (const raw of [
  "",
  " ",
  "0",
  "-1",
  "1.5",
  "400.0",
  "+7",
  "01",
  "1e3",
  "0x10",
  "1_000",
  "NaN",
  "Infinity",
  "true",
  "private-invalid-value",
  "9007199254740992",
  "9".repeat(400),
]) {
  test(`invalid explicit agent max steps fails startup: ${JSON.stringify(raw.slice(0, 30))}`, async () => {
    process.env[maxStepsEnv] = raw;
    vi.resetModules();
    await assert.rejects(import("./config"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /SOURCEWEFT_AGENT_MAX_STEPS must be a positive decimal safe integer/,
      );
      assert.doesNotMatch(error.message, /private-invalid-value/);
      return true;
    });
  });
}

for (const retired of retiredToolLimitEnvs) {
  for (const value of ["", "48", "private-retired-value"]) {
    test(`retired tool-count setting requires explicit migration even with max steps: ${retired}/${value ? "set" : "empty"}`, async () => {
      process.env[retired] = value;
      process.env[maxStepsEnv] = "400";
      vi.resetModules();
      await assert.rejects(import("./config"), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(retired));
        assert.match(
          error.message,
          /Remove it and configure SOURCEWEFT_AGENT_MAX_STEPS instead/,
        );
        assert.match(error.message, /different units/);
        assert.doesNotMatch(error.message, /private-retired-value/);
        return true;
      });
    });
  }
}

test("MCP overview pace defaults to 20 versions every 5 minutes", async () => {
  vi.resetModules();

  const { config } = await import("./config");

  assert.equal(config.market.overviewBatchSize, 20);
  assert.equal(config.market.overviewIntervalMs, 300_000);
});

test("MCP overview pace is configurable via environment", async () => {
  vi.stubEnv("MCP_OVERVIEW_BATCH_SIZE", "60");
  vi.stubEnv("MCP_OVERVIEW_INTERVAL_MS", "120000");
  vi.resetModules();

  const { config } = await import("./config");

  assert.equal(config.market.overviewBatchSize, 60);
  assert.equal(config.market.overviewIntervalMs, 120_000);
});

for (const [name, value] of [
  ["MCP_OVERVIEW_BATCH_SIZE", "0"],
  ["MCP_OVERVIEW_BATCH_SIZE", "1001"],
  ["MCP_OVERVIEW_BATCH_SIZE", "2.5"],
  ["MCP_OVERVIEW_BATCH_SIZE", "many"],
  ["MCP_OVERVIEW_INTERVAL_MS", "5000"],
  ["MCP_OVERVIEW_INTERVAL_MS", "86400001"],
] as const) {
  test(`MCP overview pace rejects ${name}=${value} at startup`, async () => {
    vi.stubEnv(name, value);
    vi.resetModules();

    await assert.rejects(
      import("./config"),
      new RegExp(`${name} must be an integer between`),
    );
  });
}

test("skill overview batch defaults to 20 and accepts a bounded override", async () => {
  vi.resetModules();
  assert.equal(
    (await import("./config")).config.market.skillOverviewBatchSize,
    20,
  );
  vi.stubEnv("SKILL_OVERVIEW_BATCH_SIZE", "200");
  vi.resetModules();
  assert.equal(
    (await import("./config")).config.market.skillOverviewBatchSize,
    200,
  );
});
for (const value of ["0", "1001", "2.5", "many"]) {
  test(`skill overview batch rejects ${value}`, async () => {
    vi.stubEnv("SKILL_OVERVIEW_BATCH_SIZE", value);
    vi.resetModules();
    await assert.rejects(
      import("./config"),
      /SKILL_OVERVIEW_BATCH_SIZE must be an integer between/,
    );
  });
}

test("skill import concurrency defaults to two and accepts eight", async () => {
  vi.stubEnv("SKILL_INGEST_WORKER_CONCURRENCY", "2");
  vi.resetModules();
  assert.equal(
    (await import("./config")).config.skillIngestWorkerConcurrency,
    2,
  );
  vi.stubEnv("SKILL_INGEST_WORKER_CONCURRENCY", "8");
  vi.resetModules();
  assert.equal(
    (await import("./config")).config.skillIngestWorkerConcurrency,
    8,
  );
});
for (const value of ["0", "33", "2.5", "many"]) {
  test(`skill import concurrency rejects ${value}`, async () => {
    vi.stubEnv("SKILL_INGEST_WORKER_CONCURRENCY", value);
    vi.resetModules();
    await assert.rejects(
      import("./config"),
      /SKILL_INGEST_WORKER_CONCURRENCY must be an integer between/,
    );
  });
}

for (const raw of [
  "",
  "0",
  "-1",
  "1.2",
  "40.0",
  "01",
  "1e3",
  "NaN",
  "9007199254740992",
]) {
  test(`invalid explicit closing budget fails startup: ${JSON.stringify(raw)}`, async () => {
    process.env[closingStepsEnv] = raw;
    vi.resetModules();
    await assert.rejects(
      import("./config"),
      /SOURCEWEFT_AGENT_CLOSING_STEPS must be a positive decimal safe integer/,
    );
  });
}
test("closing budget supports a strict override and rejects unsafe combined budgets", async () => {
  process.env[closingStepsEnv] = " 12 ";
  vi.resetModules();
  assert.equal((await import("./config")).config.chat.agent.closingSteps, 12);
  process.env[maxStepsEnv] = String(Number.MAX_SAFE_INTEGER);
  vi.resetModules();
  await assert.rejects(
    import("./config"),
    /MAX_STEPS \+ SOURCEWEFT_AGENT_CLOSING_STEPS must be a safe integer/,
  );
});
