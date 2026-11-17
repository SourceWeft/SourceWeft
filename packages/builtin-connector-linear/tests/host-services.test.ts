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

test("Linear capability stays unavailable when unset, false, or 0", async () => {
  const unset = await createConnectorAdapters({
    env: environment({ LINEAR_CLIENT_ID: "id", LINEAR_CLIENT_SECRET: "secret" }),
  });
  assert.equal(unset.adapters.length, 0);
  assert.equal(unset.agentToolDefs.length, 0);

  for (const value of ["false", "0"]) {
    const result = await createConnectorAdapters({
      env: environment({
        LINEAR_CONNECTOR_ENABLED: value,
        LINEAR_CLIENT_ID: "id",
        LINEAR_CLIENT_SECRET: "secret",
      }),
    });
    assert.equal(result.adapters.length, 0);
    assert.equal(result.agentToolDefs.length, 0);
  }
});

test("Linear capability registers one adapter and three tool defs without warning when fully configured", async () => {
  const { warnings, logger } = recordingLogger();
  const result = await createConnectorAdapters({
    env: environment({
      LINEAR_CONNECTOR_ENABLED: " TRUE ",
      LINEAR_CLIENT_ID: "id",
      LINEAR_CLIENT_SECRET: "secret",
    }),
    logger,
  });
  assert.equal(result.adapters.length, 1);
  assert.equal(result.agentToolDefs.length, 3);
  assert.equal(result.adapters[0]?.getManifest().type, "linear");
  assert.equal(
    result.adapters[0]?.getManifest().auth.authorizationParams?.client_id,
    "id",
  );
  assert.deepEqual(warnings, []);
});

test("host services accept activation value 1", async () => {
  const result = await createConnectorAdapters({
    env: environment({
      LINEAR_CONNECTOR_ENABLED: "1",
      LINEAR_CLIENT_ID: "id",
      LINEAR_CLIENT_SECRET: "secret",
    }),
  });
  assert.equal(result.adapters.length, 1);
  assert.equal(result.agentToolDefs.length, 3);
});

test("Linear capability rejects malformed activation", () => {
  assert.throws(
    () =>
      createConnectorAdapters({
        env: environment({ LINEAR_CONNECTOR_ENABLED: "yes" }),
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "LINEAR_CONNECTOR_ENABLED must be true, false, 1, or 0",
      );
      return true;
    },
  );
});

test("Linear capability stays registered, warns, and offers no client id when a credential is missing", async () => {
  for (const [values, missing] of [
    [{ LINEAR_CLIENT_ID: "id" }, ["LINEAR_CLIENT_SECRET"]],
    [{ LINEAR_CLIENT_SECRET: "secret" }, ["LINEAR_CLIENT_ID"]],
    [{}, ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET"]],
  ] as const) {
    const { warnings, logger } = recordingLogger();
    const result = await createConnectorAdapters({
      env: environment({ LINEAR_CONNECTOR_ENABLED: "true", ...values }),
      logger,
    });
    assert.equal(result.adapters.length, 1);
    const manifest = result.adapters[0]!.getManifest();
    assert.equal(manifest.type, "linear");
    // An empty client id makes the platform refuse authorization with
    // CONNECTOR_OAUTH_CONFIG_MISSING before the user is sent to Linear.
    assert.equal(manifest.auth.authorizationParams?.client_id, "");
    assert.deepEqual(warnings, [
      {
        message: "connector_not_configured",
        meta: { connectorType: "linear", missing: [...missing] },
      },
    ]);
  }
});
