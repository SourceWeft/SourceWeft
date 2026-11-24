import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, test, vi } from "vitest";

vi.mock("dotenv/config", () => ({}));

const NAMES = [
  "AUTH_APPLE_APP_BUNDLE_ID",
  "AUTH_APPLE_SERVICES_ID",
  "AUTH_APPLE_TEAM_ID",
  "AUTH_APPLE_KEY_ID",
  "AUTH_APPLE_PRIVATE_KEY",
] as const;

const ecKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

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

function setKey(privateKey = ecKey) {
  vi.stubEnv("AUTH_APPLE_TEAM_ID", "TEAM123456");
  vi.stubEnv("AUTH_APPLE_KEY_ID", "KEY1234567");
  vi.stubEnv("AUTH_APPLE_PRIVATE_KEY", privateKey);
}

test("Sign in with Apple is off and keyless by default", async () => {
  const { config } = await import("./config");
  assert.equal(config.auth.appleAppBundleId, "");
  assert.equal(config.auth.appleServicesId, "");
  assert.equal(config.auth.appleTeamId, "");
  assert.equal(config.auth.appleKeyId, "");
  assert.equal(config.auth.applePrivateKey, "");
});

test("a bundle id with the complete key turns Sign in with Apple on", async () => {
  vi.stubEnv("AUTH_APPLE_APP_BUNDLE_ID", " nicelab.sourceweft.mobile ");
  setKey();
  const { config } = await import("./config");
  assert.equal(config.auth.appleAppBundleId, "nicelab.sourceweft.mobile");
  assert.equal(config.auth.appleTeamId, "TEAM123456");
  assert.equal(config.auth.appleKeyId, "KEY1234567");
  assert.equal(config.auth.applePrivateKey, ecKey.trim());
});

test("a private key pasted on one line with literal \\n sequences is accepted", async () => {
  vi.stubEnv("AUTH_APPLE_APP_BUNDLE_ID", "nicelab.sourceweft.mobile");
  setKey(ecKey.trim().replace(/\n/g, "\\n"));
  const { config } = await import("./config");
  assert.equal(config.auth.applePrivateKey, ecKey.trim());
});

test("a bundle id without the key fails loading and names what is missing", async () => {
  vi.stubEnv("AUTH_APPLE_APP_BUNDLE_ID", "nicelab.sourceweft.mobile");
  await assert.rejects(
    import("./config"),
    /AUTH_APPLE_TEAM_ID, AUTH_APPLE_KEY_ID, AUTH_APPLE_PRIVATE_KEY are missing/,
  );

  vi.resetModules();
  setKey();
  vi.stubEnv("AUTH_APPLE_KEY_ID", "");
  await assert.rejects(import("./config"), /AUTH_APPLE_KEY_ID is missing/);
});

test("key variables without a bundle id fail loading instead of being ignored", async () => {
  vi.stubEnv("AUTH_APPLE_TEAM_ID", "TEAM123456");
  await assert.rejects(
    import("./config"),
    /AUTH_APPLE_TEAM_ID set without AUTH_APPLE_APP_BUNDLE_ID/,
  );
});

test("a private key that is unreadable or not EC P-256 fails loading", async () => {
  vi.stubEnv("AUTH_APPLE_APP_BUNDLE_ID", "nicelab.sourceweft.mobile");
  setKey("not a key");
  await assert.rejects(import("./config"), /not a readable private key/);

  vi.resetModules();
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  setKey(rsa);
  await assert.rejects(import("./config"), /EC P-256/);

  vi.resetModules();
  const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  setKey(p384);
  await assert.rejects(import("./config"), /EC P-256/);
});

test("the private key never appears in a configuration error", async () => {
  vi.stubEnv("AUTH_APPLE_APP_BUNDLE_ID", "nicelab.sourceweft.mobile");
  setKey(
    "-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----",
  );
  await assert.rejects(import("./config"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes("secret-material"));
    return true;
  });
});

test("a Services ID with the key turns web Sign in with Apple on, with or without the iOS app", async () => {
  vi.stubEnv("AUTH_APPLE_SERVICES_ID", " com.sourceweft.web ");
  setKey();
  let { config } = await import("./config");
  assert.equal(config.auth.appleServicesId, "com.sourceweft.web");
  assert.equal(config.auth.appleAppBundleId, "");
  assert.equal(config.auth.appleKeyId, "KEY1234567");

  vi.resetModules();
  vi.stubEnv("AUTH_APPLE_APP_BUNDLE_ID", "nicelab.sourceweft.mobile");
  ({ config } = await import("./config"));
  assert.equal(config.auth.appleServicesId, "com.sourceweft.web");
  assert.equal(config.auth.appleAppBundleId, "nicelab.sourceweft.mobile");
});

test("a Services ID without the key fails loading and names what is missing", async () => {
  vi.stubEnv("AUTH_APPLE_SERVICES_ID", "com.sourceweft.web");
  await assert.rejects(
    import("./config"),
    /AUTH_APPLE_SERVICES_ID is set but AUTH_APPLE_TEAM_ID, AUTH_APPLE_KEY_ID, AUTH_APPLE_PRIVATE_KEY are missing/,
  );

  vi.resetModules();
  vi.stubEnv("AUTH_APPLE_APP_BUNDLE_ID", "nicelab.sourceweft.mobile");
  setKey();
  vi.stubEnv("AUTH_APPLE_PRIVATE_KEY", "");
  await assert.rejects(
    import("./config"),
    /AUTH_APPLE_APP_BUNDLE_ID and AUTH_APPLE_SERVICES_ID are set but AUTH_APPLE_PRIVATE_KEY is missing/,
  );
});

test("the Services ID cannot be the iOS bundle id", async () => {
  vi.stubEnv("AUTH_APPLE_APP_BUNDLE_ID", "nicelab.sourceweft.mobile");
  vi.stubEnv("AUTH_APPLE_SERVICES_ID", "nicelab.sourceweft.mobile");
  setKey();
  await assert.rejects(import("./config"), /not the iOS app's bundle id/);
});
