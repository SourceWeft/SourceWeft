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

function assertGoogleMode(manifest: { auth: { kind: string } }) {
  assert.equal(manifest.auth.kind, "oauth2");
}

function assertComposioMode(manifest: { auth: { kind: string } }) {
  assert.equal(manifest.auth.kind, "brokered");
}

test("GMAIL_AUTH_PROVIDER unset stays in google mode, identical to before", async () => {
  const result = await createConnectorAdapters({
    env: environment({
      GMAIL_CONNECTOR_ENABLED: "true",
      GMAIL_CLIENT_ID: "id",
      GMAIL_CLIENT_SECRET: "secret",
    }),
  });
  assertGoogleMode(result.adapters[0]!.getManifest());
});

test("GMAIL_AUTH_PROVIDER=google stays in google mode", async () => {
  const result = await createConnectorAdapters({
    env: environment({
      GMAIL_CONNECTOR_ENABLED: "true",
      GMAIL_AUTH_PROVIDER: "google",
      GMAIL_CLIENT_ID: "id",
      GMAIL_CLIENT_SECRET: "secret",
    }),
  });
  assertGoogleMode(result.adapters[0]!.getManifest());
});

test("GMAIL_AUTH_PROVIDER=composio with a key registers a working composio-mode adapter", async () => {
  const { warnings, logger } = recordingLogger();
  const result = await createConnectorAdapters({
    env: environment({
      GMAIL_CONNECTOR_ENABLED: "true",
      GMAIL_AUTH_PROVIDER: "composio",
      COMPOSIO_API_KEY: "key",
    }),
    logger,
  });
  assert.equal(result.adapters.length, 1);
  assertComposioMode(result.adapters[0]!.getManifest());
  assert.deepEqual(warnings, []);
});

test("GMAIL_AUTH_PROVIDER=composio without a key stays registered, warns, and refuses to start authorization", async () => {
  const { warnings, logger } = recordingLogger();
  const result = await createConnectorAdapters({
    env: environment({
      GMAIL_CONNECTOR_ENABLED: "true",
      GMAIL_AUTH_PROVIDER: "composio",
    }),
    logger,
  });
  assert.equal(result.adapters.length, 1);
  assertComposioMode(result.adapters[0]!.getManifest());
  assert.deepEqual(warnings, [
    {
      message: "connector_not_configured",
      meta: { connectorType: "gmail", missing: ["COMPOSIO_API_KEY"] },
    },
  ]);
  await assert.rejects(
    result.adapters[0]!.startAuthorization!({
      callbackUrl: "https://api.sourceweft.example/callback",
      ownerRef: "ws_workspace",
    }),
    { statusCode: 500, code: "CONNECTOR_OAUTH_CONFIG_MISSING" },
  );
});

test("GMAIL_AUTH_PROVIDER is trimmed and lower-cased before matching", async () => {
  const result = await createConnectorAdapters({
    env: environment({
      GMAIL_CONNECTOR_ENABLED: "true",
      GMAIL_AUTH_PROVIDER: "Composio ",
      COMPOSIO_API_KEY: "key",
    }),
  });
  assertComposioMode(result.adapters[0]!.getManifest());
});

test("an unrecognized GMAIL_AUTH_PROVIDER throws", () => {
  assert.throws(
    () =>
      createConnectorAdapters({
        env: environment({
          GMAIL_CONNECTOR_ENABLED: "true",
          GMAIL_AUTH_PROVIDER: "foo",
          GMAIL_CLIENT_ID: "id",
          GMAIL_CLIENT_SECRET: "secret",
        }),
      }),
    /GMAIL_AUTH_PROVIDER must be google or composio/,
  );
});

test("COMPOSIO_API_KEY alone, with no GMAIL_AUTH_PROVIDER, still yields google mode", async () => {
  const result = await createConnectorAdapters({
    env: environment({
      GMAIL_CONNECTOR_ENABLED: "true",
      COMPOSIO_API_KEY: "key",
      GMAIL_CLIENT_ID: "id",
      GMAIL_CLIENT_SECRET: "secret",
    }),
  });
  assertGoogleMode(result.adapters[0]!.getManifest());
});
