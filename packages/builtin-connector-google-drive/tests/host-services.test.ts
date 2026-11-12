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
  GOOGLE_DRIVE_PICKER_API_KEY: "picker-key",
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

test("Google Drive capability requires all three credentials when enabled", () => {
  assert.throws(
    () =>
      createConnectorAdapters({
        env: environment({
          GOOGLE_DRIVE_CONNECTOR_ENABLED: "true",
          GOOGLE_DRIVE_CLIENT_ID: CREDENTIALS.GOOGLE_DRIVE_CLIENT_ID,
          GOOGLE_DRIVE_CLIENT_SECRET: CREDENTIALS.GOOGLE_DRIVE_CLIENT_SECRET,
        }),
      }),
    /GOOGLE_DRIVE_PICKER_API_KEY/,
  );
});

test("Google Drive capability rejects a client id without a project number", () => {
  assert.throws(() =>
    createConnectorAdapters({
      env: environment({
        GOOGLE_DRIVE_CONNECTOR_ENABLED: "true",
        GOOGLE_DRIVE_CLIENT_ID: "abc.apps.googleusercontent.com",
        GOOGLE_DRIVE_CLIENT_SECRET: CREDENTIALS.GOOGLE_DRIVE_CLIENT_SECRET,
        GOOGLE_DRIVE_PICKER_API_KEY: CREDENTIALS.GOOGLE_DRIVE_PICKER_API_KEY,
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
