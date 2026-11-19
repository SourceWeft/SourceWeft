import assert from "node:assert/strict";
import test from "node:test";
import { createConnectorAdapters } from "../src/host-services";
import type { ConnectorManifest } from "@sourceweft/contracts";

// The Dropbox manifest always uses the platform's standard OAuth2 flow; this
// narrows the manifest's auth union so its OAuth2 fields can be read.
function oauth2Auth(manifest: ConnectorManifest) {
  assert.equal(manifest.auth.kind, "oauth2");
  if (manifest.auth.kind !== "oauth2") throw new Error("unreachable");
  return manifest.auth;
}

function environment(values: Record<string, string> = {}) {
  return {
    baseUrl: "https://api.sourceweft.example",
    get(name: string) {
      return values[name];
    },
  };
}

const CREDENTIALS = {
  DROPBOX_CLIENT_ID: "dbx-client-id",
  DROPBOX_CLIENT_SECRET: "secret",
};

test("Dropbox capability stays unavailable until explicitly enabled", async () => {
  const result = await createConnectorAdapters({
    env: environment({ ...CREDENTIALS }),
  });
  assert.equal(result.adapters.length, 0);
  assert.equal(result.agentToolDefs.length, 0);
});

test("Dropbox capability treats false and 0 as disabled", async () => {
  const withFalse = await createConnectorAdapters({
    env: environment({
      ...CREDENTIALS,
      DROPBOX_CONNECTOR_ENABLED: " False ",
    }),
  });
  assert.equal(withFalse.adapters.length, 0);

  const withZero = await createConnectorAdapters({
    env: environment({
      ...CREDENTIALS,
      DROPBOX_CONNECTOR_ENABLED: "0",
    }),
  });
  assert.equal(withZero.adapters.length, 0);
});

test("Dropbox capability accepts whitespace- and case-insensitive true and registers one adapter with no warning", async () => {
  const { warnings, logger } = recordingLogger();
  const result = await createConnectorAdapters({
    env: environment({
      ...CREDENTIALS,
      DROPBOX_CONNECTOR_ENABLED: " TRUE ",
    }),
    logger,
  });
  assert.equal(result.adapters.length, 1);
  assert.equal(result.agentToolDefs.length, 0);
  assert.deepEqual(warnings, []);
  assert.equal(
    oauth2Auth(result.adapters[0]!.getManifest()).authorizationParams?.client_id,
    CREDENTIALS.DROPBOX_CLIENT_ID,
  );
});

test("Dropbox capability rejects malformed activation", () => {
  assert.throws(
    () =>
      createConnectorAdapters({
        env: environment({ DROPBOX_CONNECTOR_ENABLED: "yes" }),
      }),
    /DROPBOX_CONNECTOR_ENABLED must be true, false, 1, or 0/,
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

test("Dropbox capability stays registered, warns, and offers no client id when a credential is missing", async () => {
  for (const [values, missing] of [
    [
      { DROPBOX_CLIENT_ID: CREDENTIALS.DROPBOX_CLIENT_ID },
      ["DROPBOX_CLIENT_SECRET"],
    ],
    [
      { DROPBOX_CLIENT_SECRET: CREDENTIALS.DROPBOX_CLIENT_SECRET },
      ["DROPBOX_CLIENT_ID"],
    ],
    [{}, ["DROPBOX_CLIENT_ID", "DROPBOX_CLIENT_SECRET"]],
  ] as const) {
    const { warnings, logger } = recordingLogger();
    const result = await createConnectorAdapters({
      env: environment({ DROPBOX_CONNECTOR_ENABLED: "true", ...values }),
      logger,
    });
    assert.equal(result.adapters.length, 1);
    const manifest = result.adapters[0]!.getManifest();
    assert.equal(manifest.type, "dropbox");
    // An empty client id makes the platform refuse authorization with
    // CONNECTOR_OAUTH_CONFIG_MISSING before the user is sent to Dropbox.
    assert.equal(oauth2Auth(manifest).authorizationParams?.client_id, "");
    assert.deepEqual(warnings, [
      {
        message: "connector_not_configured",
        meta: { connectorType: "dropbox", missing: [...missing] },
      },
    ]);
  }
});

test("Dropbox capability does not warn when switched off or fully configured", async () => {
  const { warnings, logger } = recordingLogger();
  await createConnectorAdapters({ env: environment({}), logger });
  const configured = await createConnectorAdapters({
    env: environment({ DROPBOX_CONNECTOR_ENABLED: "1", ...CREDENTIALS }),
    logger,
  });
  assert.equal(
    oauth2Auth(configured.adapters[0]!.getManifest()).authorizationParams?.client_id,
    CREDENTIALS.DROPBOX_CLIENT_ID,
  );
  assert.deepEqual(warnings, []);
});

test("Dropbox capability registers one adapter and no agent tools when enabled", async () => {
  const result = await createConnectorAdapters({
    env: environment({
      DROPBOX_CONNECTOR_ENABLED: "true",
      ...CREDENTIALS,
    }),
  });
  assert.equal(result.adapters.length, 1);
  assert.equal(result.agentToolDefs.length, 0);
});
