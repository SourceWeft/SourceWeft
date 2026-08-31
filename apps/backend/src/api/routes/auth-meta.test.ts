import assert from "node:assert/strict";
import { Hono } from "hono";
import { test } from "vitest";
import { config } from "../../shared/config";
import { registerAuthMetaRoutes } from "./auth-meta";

test("publishes the extension client resource with its OAuth contract", async () => {
  const app = new Hono();
  registerAuthMetaRoutes(app);

  const response = await app.request("http://localhost/v1/auth/config");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    oneTapEnabled: Boolean(config.auth.googleOneTapClientId),
    extension: {
      enabled: config.auth.extensionEnabled,
      clientId: config.auth.extensionClientId,
      redirectUri: config.auth.extensionRedirectUri,
      resource: config.auth.baseUrl,
    },
  });
});
