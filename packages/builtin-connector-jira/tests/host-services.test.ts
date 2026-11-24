import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorManifest } from "@sourceweft/contracts";
import { createConnectorAdapters } from "../src/host-services";

// The Jira manifest always uses the platform's standard OAuth2 flow; this
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
  JIRA_CLIENT_ID: "jira-client-id",
  JIRA_CLIENT_SECRET: "secret",
};

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

test("Jira capability stays unavailable until explicitly enabled", async () => {
  const result = await createConnectorAdapters({
    env: environment({ ...CREDENTIALS }),
  });
  assert.equal(result.adapters.length, 0);
  assert.equal(result.agentToolDefs.length, 0);
});

test("Jira capability treats false and 0 as disabled", async () => {
  const withFalse = await createConnectorAdapters({
    env: environment({ ...CREDENTIALS, JIRA_CONNECTOR_ENABLED: " False " }),
  });
  assert.equal(withFalse.adapters.length, 0);

  const withZero = await createConnectorAdapters({
    env: environment({ ...CREDENTIALS, JIRA_CONNECTOR_ENABLED: "0" }),
  });
  assert.equal(withZero.adapters.length, 0);
});

test("Jira capability accepts whitespace- and case-insensitive true and registers one adapter and three tools with no warning", async () => {
  const { warnings, logger } = recordingLogger();
  const result = await createConnectorAdapters({
    env: environment({ ...CREDENTIALS, JIRA_CONNECTOR_ENABLED: " TRUE " }),
    logger,
  });
  assert.equal(result.adapters.length, 1);
  assert.equal(result.agentToolDefs.length, 3);
  assert.deepEqual(warnings, []);
  assert.equal(
    oauth2Auth(result.adapters[0]!.getManifest()).authorizationParams?.client_id,
    CREDENTIALS.JIRA_CLIENT_ID,
  );
});

test("Jira capability rejects malformed activation with the exact message", () => {
  assert.throws(
    () =>
      createConnectorAdapters({
        env: environment({ JIRA_CONNECTOR_ENABLED: "yes" }),
      }),
    /JIRA_CONNECTOR_ENABLED must be true, false, 1, or 0/,
  );
});

test("Jira capability stays registered, warns, and offers no client id when a credential is missing", async () => {
  for (const [values, missing] of [
    [{ JIRA_CLIENT_ID: CREDENTIALS.JIRA_CLIENT_ID }, ["JIRA_CLIENT_SECRET"]],
    [
      { JIRA_CLIENT_SECRET: CREDENTIALS.JIRA_CLIENT_SECRET },
      ["JIRA_CLIENT_ID"],
    ],
    [{}, ["JIRA_CLIENT_ID", "JIRA_CLIENT_SECRET"]],
  ] as const) {
    const { warnings, logger } = recordingLogger();
    const result = await createConnectorAdapters({
      env: environment({ JIRA_CONNECTOR_ENABLED: "true", ...values }),
      logger,
    });
    assert.equal(result.adapters.length, 1);
    const manifest = result.adapters[0]!.getManifest();
    assert.equal(manifest.type, "jira");
    // An empty client id makes the platform refuse authorization with
    // CONNECTOR_OAUTH_CONFIG_MISSING before the user is sent to Atlassian.
    assert.equal(oauth2Auth(manifest).authorizationParams?.client_id, "");
    assert.deepEqual(warnings, [
      {
        message: "connector_not_configured",
        meta: { connectorType: "jira", missing: [...missing] },
      },
    ]);
  }
});

test("Jira capability does not warn when switched off or fully configured", async () => {
  const { warnings, logger } = recordingLogger();
  await createConnectorAdapters({ env: environment({}), logger });
  const configured = await createConnectorAdapters({
    env: environment({ JIRA_CONNECTOR_ENABLED: "1", ...CREDENTIALS }),
    logger,
  });
  assert.equal(
    oauth2Auth(configured.adapters[0]!.getManifest()).authorizationParams?.client_id,
    CREDENTIALS.JIRA_CLIENT_ID,
  );
  assert.deepEqual(warnings, []);
});
