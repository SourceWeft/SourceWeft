import assert from "node:assert/strict";
import { Hono } from "hono";
import { test } from "vitest";
import { config } from "../../shared/config";
import { mailDeliveryConfigured } from "../../modules/mail/delivery";
import { registerAuthMetaRoutes } from "./auth-meta";

test("publishes the extension client resource with its OAuth contract", async () => {
  const app = new Hono();
  registerAuthMetaRoutes(app);

  const response = await app.request("http://localhost/v1/auth/config");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    oneTapEnabled: Boolean(config.auth.googleOneTapClientId),
    // The default mail provider delivers nothing, so nobody is made to wait
    // for a verification email; the auth views route on this.
    requireEmailVerification: mailDeliveryConfigured(),
    extension: {
      enabled: config.auth.extensionEnabled,
      clientId: config.auth.extensionClientId,
      redirectUri: config.auth.extensionRedirectUri,
      resource: config.auth.baseUrl,
    },
  });
});
