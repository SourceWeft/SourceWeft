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

const CREDENTIALS = {
  GOOGLE_DRIVE_CLIENT_ID: "123456789-x.apps.googleusercontent.com",
  GOOGLE_DRIVE_CLIENT_SECRET: "secret",
};

test("Google Drive capability stays unavailable until explicitly enabled", async () => {
  const result = await createConnectorAdapters({
    env: environment({ ...CREDENTIALS }),
  });
  assert.equal(result.adapters.length, 0);
  assert.equal(result.agentToolDefs.length, 0);
});

test("Google Drive capability treats false and 0 as disabled", async () => {
  const withFalse = await createConnectorAdapters({
    env: environment({
      ...CREDENTIALS,
      GOOGLE_DRIVE_CONNECTOR_ENABLED: " False ",
    }),
  });
  assert.equal(withFalse.adapters.length, 0);

  const withZero = await createConnectorAdapters({
    env: environment({
      ...CREDENTIALS,
      GOOGLE_DRIVE_CONNECTOR_ENABLED: "0",
    }),
  });
  assert.equal(withZero.adapters.length, 0);
});

test("Google Drive capability rejects malformed activation", () => {
  assert.throws(
    () =>
      createConnectorAdapters({
        env: environment({ GOOGLE_DRIVE_CONNECTOR_ENABLED: "perhaps" }),
      }),
    /GOOGLE_DRIVE_CONNECTOR_ENABLED must be true, false, 1, or 0/,
  );
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

test("Google Drive capability stays registered, warns, and offers no client id when a credential is missing", async () => {
  for (const [values, missing] of [
    [
      { GOOGLE_DRIVE_CLIENT_ID: CREDENTIALS.GOOGLE_DRIVE_CLIENT_ID },
      ["GOOGLE_DRIVE_CLIENT_SECRET"],
    ],
    [
      { GOOGLE_DRIVE_CLIENT_SECRET: CREDENTIALS.GOOGLE_DRIVE_CLIENT_SECRET },
      ["GOOGLE_DRIVE_CLIENT_ID"],
    ],
    [{}, ["GOOGLE_DRIVE_CLIENT_ID", "GOOGLE_DRIVE_CLIENT_SECRET"]],
  ] as const) {
    const { warnings, logger } = recordingLogger();
    const result = await createConnectorAdapters({
      env: environment({ GOOGLE_DRIVE_CONNECTOR_ENABLED: "true", ...values }),
      logger,
    });
    assert.equal(result.adapters.length, 1);
    const manifest = result.adapters[0]!.getManifest();
    assert.equal(manifest.type, "google_drive");
    // An empty client id makes the platform refuse authorization with
    // CONNECTOR_OAUTH_CONFIG_MISSING before the user is sent to Google.
    assert.equal(manifest.auth.authorizationParams?.client_id, "");
    assert.deepEqual(warnings, [
      {
        message: "connector_not_configured",
        meta: { connectorType: "google_drive", missing: [...missing] },
      },
    ]);
  }
});

test("Google Drive capability does not warn when switched off or fully configured", async () => {
  const { warnings, logger } = recordingLogger();
  await createConnectorAdapters({ env: environment({}), logger });
  const configured = await createConnectorAdapters({
    env: environment({ GOOGLE_DRIVE_CONNECTOR_ENABLED: "1", ...CREDENTIALS }),
    logger,
  });
  assert.equal(
    configured.adapters[0]?.getManifest().auth.authorizationParams?.client_id,
    CREDENTIALS.GOOGLE_DRIVE_CLIENT_ID,
  );
  assert.deepEqual(warnings, []);
});

test("Google Drive capability rejects a malformed client id even without a secret", () => {
  assert.throws(
    () =>
      createConnectorAdapters({
        env: environment({
          GOOGLE_DRIVE_CONNECTOR_ENABLED: "true",
          GOOGLE_DRIVE_CLIENT_ID: "abc.apps.googleusercontent.com",
        }),
      }),
    /GOOGLE_DRIVE_CLIENT_ID does not start with a Google Cloud project number/,
  );
});

test("Google Drive capability rejects a client id without a project number", () => {
  assert.throws(() =>
    createConnectorAdapters({
      env: environment({
        GOOGLE_DRIVE_CONNECTOR_ENABLED: "true",
        GOOGLE_DRIVE_CLIENT_ID: "abc.apps.googleusercontent.com",
        GOOGLE_DRIVE_CLIENT_SECRET: CREDENTIALS.GOOGLE_DRIVE_CLIENT_SECRET,
      }),
    }),
  );
});

test("Google Drive capability registers one adapter and no agent tools when enabled", async () => {
  const result = await createConnectorAdapters({
    env: environment({
      GOOGLE_DRIVE_CONNECTOR_ENABLED: "true",
      ...CREDENTIALS,
    }),
  });
  assert.equal(result.adapters.length, 1);
  assert.equal(result.agentToolDefs.length, 0);
});
