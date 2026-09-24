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

test("Gmail capability requires both credentials when enabled", async () => {
  assert.throws(
    () =>
      createConnectorAdapters({
        env: environment({
          GMAIL_CONNECTOR_ENABLED: "true",
          GMAIL_CLIENT_ID: "id",
        }),
      }),
    /GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET/,
  );
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
