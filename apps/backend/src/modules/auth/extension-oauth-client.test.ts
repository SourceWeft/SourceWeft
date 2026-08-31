import assert from "node:assert/strict";
import { test } from "vitest";
import {
  extensionOAuthClientMismatches,
  type ExtensionOAuthClientInput,
} from "./extension-oauth-client";

const input: ExtensionOAuthClientInput = {
  clientId: "sourceweft-extension",
  redirectUri: "https://extension-id.chromiumapp.org/provider_cb",
  resource: "https://api.sourceweft.test",
};

function matchingRow() {
  return {
    clientId: input.clientId,
    clientSecret: null,
    clientDiscoveryId: null,
    disabled: false,
    skipConsent: false,
    enableEndSession: false,
    subjectType: "public",
    scopes: ["email", "offline_access", "openid", "profile"],
    clientCredentialsScopes: [],
    userId: null,
    name: "SourceWeft Browser Extension",
    redirectUris: [input.redirectUri],
    postLogoutRedirectUris: null,
    backchannelLogoutUri: null,
    backchannelLogoutSessionRequired: false,
    tokenEndpointAuthMethod: "none",
    applicationType: "web",
    jwks: null,
    jwksUri: null,
    grantTypes: ["refresh_token", "authorization_code"],
    responseTypes: ["code"],
    requirePKCE: true,
    dpopBoundAccessTokens: false,
    referenceId: null,
    metadata: {
      purpose: "browser-extension",
      managedBy: "sourceweft",
    },
  };
}

test("accepts the exact managed extension client regardless of set ordering", () => {
  assert.deepEqual(extensionOAuthClientMismatches(matchingRow(), input), []);
});

test("reports every security-relevant client policy mismatch", () => {
  const row = matchingRow();
  row.redirectUris = [input.redirectUri, "https://attacker.example/callback"];
  row.grantTypes = ["authorization_code", "client_credentials"];
  row.requirePKCE = false;
  row.metadata = { managedBy: "somebody-else" } as never;

  assert.deepEqual(extensionOAuthClientMismatches(row, input), [
    "redirectUris",
    "grantTypes",
    "requirePKCE",
    "metadata",
  ]);
});
