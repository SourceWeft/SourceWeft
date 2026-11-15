import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

// Constructing the auth is required to read the resolved plugin options, but
// the oauth-provider plugin seeds its configured resources into PostgreSQL as
// a side effect of construction. Stub it so this stays a unit test (mirrors
// email-verification-policy.test.ts).
vi.mock("@better-auth/oauth-provider", () => ({
  oauthProvider: () => ({ id: "oauth-provider" }),
}));

afterEach(() => {
  vi.resetModules();
});

test("the SSO plugin is registered with the required options, and i18n stays last", async () => {
  const { createSourceweftAuth } = await import("../auth/auth-config");
  // "migration" builds the same options without the runtime-only mail hooks.
  const auth = createSourceweftAuth({ mode: "migration" });

  const plugins = auth.options.plugins ?? [];
  const ssoPlugin = plugins.find((plugin) => plugin.id === "sso");
  assert.ok(ssoPlugin, "expected a plugin with id 'sso' to be registered");

  const o = (ssoPlugin as { options: Record<string, unknown> }).options;

  assert.deepEqual(o.domainVerification, {
    enabled: true,
    tokenPrefix: "sourceweft-sso",
  });
  assert.deepEqual(o.organizationProvisioning, { disabled: true });
  assert.equal(o.provisionUserOnEveryLogin, true);
  assert.notEqual(o.trustEmailVerified, true);
  assert.notEqual(o.disableImplicitSignUp, true);
  assert.equal(o.redirectURI, "/sso/callback");
  assert.equal(o.providersLimit, 25);
  assert.deepEqual(o.saml, {
    enableInResponseToValidation: true,
    allowIdpInitiated: false,
    requireTimestamps: true,
    algorithms: { onDeprecated: "reject" },
    enableSingleLogout: false,
  });

  // The plugin's own deprecated-algorithm rejection is kept as defence in depth:
  // it DOES fire for the redirect/SimpleSign bindings. It does NOT fire on the
  // HTTP-POST binding the ACS uses (the plugin never reads the POST response's
  // signature algorithm), which is why the guard adds its own
  // `assertSamlAcsAlgorithms` before-hook — see ./saml-algorithm-policy.ts.
  assert.equal(
    (o.saml as { algorithms?: { onDeprecated?: string } }).algorithms?.onDeprecated,
    "reject",
  );

  // i18n is still the last plugin.
  assert.equal(plugins.at(-1)?.id, "i18n");
});
