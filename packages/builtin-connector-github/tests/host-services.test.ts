import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorManifest } from "@sourceweft/contracts";
import { createConnectorAdapters } from "../src/host-services";

// The GitHub manifest always uses the platform's standard OAuth2 flow; this
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
  GITHUB_CLIENT_ID: "gh-client-id",
  GITHUB_CLIENT_SECRET: "secret",
  GITHUB_APP_SLUG: "sourceweft-test",
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

test("GitHub capability stays unavailable until explicitly enabled", async () => {
  const result = await createConnectorAdapters({
    env: environment({ ...CREDENTIALS }),
  });
  assert.equal(result.adapters.length, 0);
  assert.equal(result.agentToolDefs.length, 0);
});

test("GitHub capability treats false and 0 as disabled", async () => {
  const withFalse = await createConnectorAdapters({
    env: environment({ ...CREDENTIALS, GITHUB_CONNECTOR_ENABLED: " False " }),
  });
  assert.equal(withFalse.adapters.length, 0);
  assert.equal(withFalse.agentToolDefs.length, 0);

  const withZero = await createConnectorAdapters({
    env: environment({ ...CREDENTIALS, GITHUB_CONNECTOR_ENABLED: "0" }),
  });
  assert.equal(withZero.adapters.length, 0);
  assert.equal(withZero.agentToolDefs.length, 0);
});

test("GitHub capability accepts whitespace- and case-insensitive true and registers one adapter with three tools and no warning", async () => {
  const { warnings, logger } = recordingLogger();
  const result = await createConnectorAdapters({
    env: environment({ ...CREDENTIALS, GITHUB_CONNECTOR_ENABLED: " TRUE " }),
    logger,
  });
  assert.equal(result.adapters.length, 1);
  assert.equal(result.agentToolDefs.length, 3);
  assert.deepEqual(warnings, []);
  assert.equal(
    oauth2Auth(result.adapters[0]!.getManifest()).authorizationParams?.client_id,
    CREDENTIALS.GITHUB_CLIENT_ID,
  );
});

test("GitHub capability rejects malformed activation", () => {
  assert.throws(
    () =>
      createConnectorAdapters({
        env: environment({ GITHUB_CONNECTOR_ENABLED: "yes" }),
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "GITHUB_CONNECTOR_ENABLED must be true, false, 1, or 0",
  );
});

test("GitHub capability stays registered, warns, and offers no client id when a credential is missing", async () => {
  for (const [values, missing] of [
    [
      {
        GITHUB_CLIENT_ID: CREDENTIALS.GITHUB_CLIENT_ID,
        GITHUB_APP_SLUG: CREDENTIALS.GITHUB_APP_SLUG,
      },
      ["GITHUB_CLIENT_SECRET"],
    ],
    [
      {
        GITHUB_CLIENT_SECRET: CREDENTIALS.GITHUB_CLIENT_SECRET,
        GITHUB_APP_SLUG: CREDENTIALS.GITHUB_APP_SLUG,
      },
      ["GITHUB_CLIENT_ID"],
    ],
    [
      {
        GITHUB_CLIENT_ID: CREDENTIALS.GITHUB_CLIENT_ID,
        GITHUB_CLIENT_SECRET: CREDENTIALS.GITHUB_CLIENT_SECRET,
      },
      ["GITHUB_APP_SLUG"],
    ],
    [
      {},
      ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_APP_SLUG"],
    ],
  ] as const) {
    const { warnings, logger } = recordingLogger();
    const result = await createConnectorAdapters({
      env: environment({ GITHUB_CONNECTOR_ENABLED: "true", ...values }),
      logger,
    });
    assert.equal(result.adapters.length, 1);
    const manifest = result.adapters[0]!.getManifest();
    assert.equal(manifest.type, "github");
    // An empty client id makes the platform refuse authorization with
    // CONNECTOR_OAUTH_CONFIG_MISSING before the user is sent to GitHub.
    assert.equal(oauth2Auth(manifest).authorizationParams?.client_id, "");
    assert.deepEqual(warnings, [
      {
        message: "connector_not_configured",
        meta: { connectorType: "github", missing: [...missing] },
      },
    ]);
  }
});

test("GitHub capability does not warn when switched off or fully configured", async () => {
  const { warnings, logger } = recordingLogger();
  await createConnectorAdapters({ env: environment({}), logger });
  const configured = await createConnectorAdapters({
    env: environment({ GITHUB_CONNECTOR_ENABLED: "1", ...CREDENTIALS }),
    logger,
  });
  assert.equal(
    oauth2Auth(configured.adapters[0]!.getManifest()).authorizationParams?.client_id,
    CREDENTIALS.GITHUB_CLIENT_ID,
  );
  assert.deepEqual(warnings, []);
});

test("GitHub capability rejects a malformed app slug with the exact message", () => {
  assert.throws(
    () =>
      createConnectorAdapters({
        env: environment({
          GITHUB_CONNECTOR_ENABLED: "true",
          GITHUB_CLIENT_ID: CREDENTIALS.GITHUB_CLIENT_ID,
          GITHUB_CLIENT_SECRET: CREDENTIALS.GITHUB_CLIENT_SECRET,
          GITHUB_APP_SLUG: "My App!",
        }),
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message ===
        "GITHUB_APP_SLUG must be the GitHub App's URL slug (letters, digits and hyphens)",
  );
});

test("GitHub capability accepts a slug with different casing and lower-cases it in the help link", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input));
    if (url.pathname === "/user/installations") {
      return new Response(
        JSON.stringify({ total_count: 0, installations: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  try {
    const result = await createConnectorAdapters({
      env: environment({
        GITHUB_CONNECTOR_ENABLED: "true",
        GITHUB_CLIENT_ID: CREDENTIALS.GITHUB_CLIENT_ID,
        GITHUB_CLIENT_SECRET: CREDENTIALS.GITHUB_CLIENT_SECRET,
        GITHUB_APP_SLUG: "SourceWeft-Dev",
      }),
    });
    assert.equal(result.adapters.length, 1);
    const action = await result.adapters[0]!.executeAction({
      teamId: "team",
      workspaceId: "workspace",
      connectorId: "connector",
      connectorType: "github",
      actionType: "github.browse",
      request: {},
      config: { items: [] },
      accessToken: "access-token",
      idempotencyKey: "idem-1",
    });
    assert.deepEqual(
      (action.result as { helpLink: { code: string; url: string } }).helpLink,
      {
        code: "add_repositories",
        url: "https://github.com/apps/sourceweft-dev/installations/new",
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub capability registers one adapter and three agent tools when enabled", async () => {
  const result = await createConnectorAdapters({
    env: environment({ GITHUB_CONNECTOR_ENABLED: "true", ...CREDENTIALS }),
  });
  assert.equal(result.adapters.length, 1);
  assert.equal(result.agentToolDefs.length, 3);
});
