import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test, vi } from "vitest";

vi.mock("dotenv/config", () => ({}));

const NAMES = [
  "SYSTEM_MODEL_ENABLED",
  "SYSTEM_MODEL_PROVIDER",
  "SYSTEM_MODEL_API_KEY",
  "SYSTEM_MODEL_NAME",
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
