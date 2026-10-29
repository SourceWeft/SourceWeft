import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test, vi } from "vitest";

vi.mock("dotenv/config", () => ({}));

const NAMES = [
  "SYSTEM_MODEL_ENABLED",
  "SYSTEM_MODEL_PROVIDER",
  "SYSTEM_MODEL_API_KEY",
  "SYSTEM_MODEL_NAME",
  "MARKET_AI_OFF_PEAK_ONLY",
] as const;

beforeEach(() => {
  // No developer environment may leak into these expectations.
  for (const name of NAMES) vi.stubEnv(name, undefined);
  vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost/test");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  vi.stubEnv("BETTER_AUTH_SECRET", "test-auth-secret-at-least-32-chars");
  vi.stubEnv(
    "MODEL_GATEWAY_ENCRYPTION_SECRET",
    "test-model-secret-at-least-32-chars",
  );
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

test("the system model is off and unconfigured by default", async () => {
  const { config } = await import("./config");
  assert.deepEqual(config.systemModel, {
    enabled: false,
    provider: "",
    apiKey: "",
    model: "",
  });
});

test("market off-peak scheduling is optional and disabled by default", async () => {
  const { config } = await import("./config");
  assert.equal(config.market.aiOffPeakOnly, false);
});
for (const [value, expected] of [
  ["true", true],
  [" 1 ", true],
  ["FALSE", false],
  ["0", false],
] as const) {
  test(`MARKET_AI_OFF_PEAK_ONLY=${value} is parsed strictly`, async () => {
    vi.stubEnv("MARKET_AI_OFF_PEAK_ONLY", value);
    const { config } = await import("./config");
    assert.equal(config.market.aiOffPeakOnly, expected);
  });
}
test("malformed off-peak setting fails config loading", async () => {
  vi.stubEnv("MARKET_AI_OFF_PEAK_ONLY", "yes");
  await assert.rejects(import("./config"), /MARKET_AI_OFF_PEAK_ONLY/);
});

test("settings are trimmed, and the key does not enable anything", async () => {
  vi.stubEnv("SYSTEM_MODEL_PROVIDER", " openrouter ");
  vi.stubEnv("SYSTEM_MODEL_API_KEY", " sk-test-key ");
  vi.stubEnv("SYSTEM_MODEL_NAME", " deepseek/deepseek-v4.1-flash ");
  const { config } = await import("./config");
  assert.deepEqual(config.systemModel, {
    enabled: false,
    provider: "openrouter",
    apiKey: "sk-test-key",
    model: "deepseek/deepseek-v4.1-flash",
  });
});

for (const [value, expected] of [
  ["true", true],
  ["  TRUE ", true],
  ["1", true],
  ["false", false],
  [" 0 ", false],
  ["False", false],
] as const) {
  test(`SYSTEM_MODEL_ENABLED strictly parses ${JSON.stringify(value)}`, async () => {
    vi.stubEnv("SYSTEM_MODEL_ENABLED", value);
    const { config } = await import("./config");
    assert.equal(config.systemModel.enabled, expected);
  });
}

for (const value of ["yes", "on", "", "enabled", "2"]) {
  test(`SYSTEM_MODEL_ENABLED=${JSON.stringify(value)} fails configuration loading`, async () => {
    vi.stubEnv("SYSTEM_MODEL_ENABLED", value);
    await assert.rejects(import("./config"), /SYSTEM_MODEL_ENABLED/);
  });
}

test("Docker and backend examples agree on the system model defaults", () => {
  const backend = readFileSync(
    new URL("../../.env.example", import.meta.url),
    "utf8",
  );
  const docker = readFileSync(
    new URL("../../../../docker/.env.example", import.meta.url),
    "utf8",
  );
  const compose = readFileSync(
    new URL("../../../../docker/docker-compose.yml", import.meta.url),
    "utf8",
  );
  for (const [name, value] of Object.entries({
    MARKET_AI_OFF_PEAK_ONLY: "false",
    SYSTEM_MODEL_ENABLED: "false",
    SYSTEM_MODEL_PROVIDER: "",
    SYSTEM_MODEL_API_KEY: "",
    SYSTEM_MODEL_NAME: "",
  })) {
    const line = new RegExp(`^${name}=${value}$`, "m");
    assert.match(backend, line, `apps/backend/.env.example ${name}`);
    assert.match(docker, line, `docker/.env.example ${name}`);
    assert.ok(
      compose.includes(`${name}: ${"${"}${name}:-${value}}`),
      `docker-compose.yml ${name}`,
    );
  }
});
