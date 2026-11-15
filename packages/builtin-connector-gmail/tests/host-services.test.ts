import assert from "node:assert/strict";
import test from "node:test";
import { createConnectorAdapters } from "../src/host-services";

function environment(values: Record<string, string> = {}) {
  return {
    baseUrl: "https://api.sourceweft.example",
    get(name: string) {
      return values[name];
    },
  };
}

test("Gmail capability stays unavailable until explicitly enabled", async () => {
  const missingFlag = await createConnectorAdapters({
    env: environment({ GMAIL_CLIENT_ID: "id", GMAIL_CLIENT_SECRET: "secret" }),
  });
  assert.equal(missingFlag.adapters.length, 0);
  assert.equal(missingFlag.agentToolDefs.length, 0);
});

function recordingLogger() {
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> =
    [];
  return {
    warnings,
    logger: {
      warn(message: string, meta?: Record<string, unknown>) {
        warnings.push({ message, meta });
      },
    },
  };
}

test("Gmail capability stays registered, warns, and offers no client id when a credential is missing", async () => {
  for (const [values, missing] of [
    [{ GMAIL_CLIENT_ID: "id" }, ["GMAIL_CLIENT_SECRET"]],
    [{ GMAIL_CLIENT_SECRET: "secret" }, ["GMAIL_CLIENT_ID"]],
    [{}, ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET"]],
  ] as const) {
    const { warnings, logger } = recordingLogger();
    const result = await createConnectorAdapters({
      env: environment({ GMAIL_CONNECTOR_ENABLED: "true", ...values }),
      logger,
    });
    assert.equal(result.adapters.length, 1);
    const manifest = result.adapters[0]!.getManifest();
    assert.equal(manifest.type, "gmail");
    if (manifest.auth.kind !== "oauth2") {
      throw new Error("expected gmail manifest to use oauth2 auth");
    }
    // An empty client id makes the platform refuse authorization with
    // CONNECTOR_OAUTH_CONFIG_MISSING before the user is sent to Google.
    assert.equal(manifest.auth.authorizationParams?.client_id, "");
    assert.deepEqual(warnings, [
      {
        message: "connector_not_configured",
        meta: { connectorType: "gmail", missing: [...missing] },
      },
    ]);
  }
});

test("Gmail capability does not warn when switched off or fully configured", async () => {
  const { warnings, logger } = recordingLogger();
  await createConnectorAdapters({ env: environment({}), logger });
  const configured = await createConnectorAdapters({
    env: environment({
      GMAIL_CONNECTOR_ENABLED: "1",
      GMAIL_CLIENT_ID: "id",
      GMAIL_CLIENT_SECRET: "secret",
    }),
    logger,
  });
  const manifest = configured.adapters[0]?.getManifest();
  if (!manifest || manifest.auth.kind !== "oauth2") {
    throw new Error("expected gmail manifest to use oauth2 auth");
  }
  assert.equal(manifest.auth.authorizationParams?.client_id, "id");
  assert.deepEqual(warnings, []);
});

test("Gmail capability rejects malformed activation", () => {
  assert.throws(
    () =>
      createConnectorAdapters({
        env: environment({ GMAIL_CONNECTOR_ENABLED: "perhaps" }),
      }),
    /GMAIL_CONNECTOR_ENABLED/,
  );
});

test("Gmail capability registers adapter and tools only when configured", async () => {
  const result = await createConnectorAdapters({
    env: environment({
      GMAIL_CONNECTOR_ENABLED: "true",
      GMAIL_CLIENT_ID: "id",
      GMAIL_CLIENT_SECRET: "secret",
    }),
  });
  assert.equal(result.adapters[0]?.getManifest().type, "gmail");
  assert.equal(result.agentToolDefs.length, 4);
});
