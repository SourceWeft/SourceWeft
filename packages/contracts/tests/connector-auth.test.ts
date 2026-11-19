import assert from "node:assert/strict";
import test from "node:test";
import { connectorManifestSchema } from "../src/connectors";

function baseManifest(auth: unknown) {
  return {
    type: "gmail",
    displayName: "Gmail",
    auth,
    sync: {
      supportsIncremental: true,
      defaultFrequencyMinutes: 30,
      resources: [],
    },
    actions: [],
    configSchema: {},
  };
}

test("accepts a brokered auth manifest", () => {
  const result = connectorManifestSchema.safeParse(
    baseManifest({ kind: "brokered", broker: "composio", scopes: ["a"] }),
  );
  assert.equal(result.success, true);
});

test("rejects a brokered auth manifest without a broker", () => {
  const result = connectorManifestSchema.safeParse(
    baseManifest({ kind: "brokered", scopes: ["a"] }),
  );
  assert.equal(result.success, false);
});

test("still accepts today's Gmail oauth2 manifest", () => {
  const result = connectorManifestSchema.safeParse(
    baseManifest({
      kind: "oauth2",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      redirectUri: "https://app.example.com/callback",
      authorizationParams: { access_type: "offline" },
      sendScope: true,
    }),
  );
  assert.equal(result.success, true);
});

test("rejects an oauth2 manifest without a tokenUrl", () => {
  const result = connectorManifestSchema.safeParse(
    baseManifest({
      kind: "oauth2",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    }),
  );
  assert.equal(result.success, false);
});
