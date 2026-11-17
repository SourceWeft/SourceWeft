import assert from "node:assert/strict";
import { test } from "vitest";
import { buildSsoProviderAuditEntry } from "./audit";

/**
 * Pure-function coverage for the audit-entry builder: metadata must contain
 * exactly `{ providerId, protocol, domain }`, no matter what else the
 * endpoint response or DB row it was built from was carrying.
 */

test("an OIDC provider carrying a clientSecret yields oidc metadata with exactly providerId/protocol/domain", () => {
  const entry = buildSsoProviderAuditEntry({
    action: "sso.provider_created",
    teamId: "team-1",
    actorUserId: "user-1",
    provider: {
      providerId: "provider-oidc-1",
      domain: "acme.example",
      // No samlConfig: an OIDC row. Extra, unrelated fields (including the
      // secret) must never leak into the recorded metadata.
      oidcConfig: { clientId: "client-1", clientSecret: "s3cr3t" },
    } as never,
  });

  assert.equal(entry.teamId, "team-1");
  assert.equal(entry.actorUserId, "user-1");
  assert.equal(entry.action, "sso.provider_created");
  assert.equal(entry.targetType, "sso_provider");
  assert.equal(entry.targetId, "provider-oidc-1");
  assert.deepEqual(Object.keys(entry.metadata ?? {}).sort(), [
    "domain",
    "protocol",
    "providerId",
  ]);
  assert.deepEqual(entry.metadata, {
    providerId: "provider-oidc-1",
    protocol: "oidc",
    domain: "acme.example",
  });
  assert.equal(JSON.stringify(entry.metadata).includes("s3cr3t"), false);
  assert.equal(JSON.stringify(entry.metadata).includes("clientSecret"), false);
});

test("a SAML provider carrying a cert yields saml metadata with exactly providerId/protocol/domain", () => {
  const entry = buildSsoProviderAuditEntry({
    action: "sso.provider_updated",
    teamId: "team-2",
    actorUserId: "user-2",
    provider: {
      providerId: "provider-saml-1",
      domain: "widgets.example",
      samlConfig: {
        cert: "-----BEGIN CERTIFICATE-----\nMIIBdummy==\n-----END CERTIFICATE-----",
        entryPoint: "https://idp.example.com/sso",
      },
    },
  });

  assert.equal(entry.action, "sso.provider_updated");
  assert.deepEqual(Object.keys(entry.metadata ?? {}).sort(), [
    "domain",
    "protocol",
    "providerId",
  ]);
  assert.deepEqual(entry.metadata, {
    providerId: "provider-saml-1",
    protocol: "saml",
    domain: "widgets.example",
  });
  assert.equal(JSON.stringify(entry.metadata).includes("CERTIFICATE"), false);
  assert.equal(JSON.stringify(entry.metadata).includes("entryPoint"), false);
});

test("the actor can be null (no resolvable session)", () => {
  const entry = buildSsoProviderAuditEntry({
    action: "sso.provider_deleted",
    teamId: "team-3",
    actorUserId: null,
    provider: { providerId: "provider-3", domain: "example.org" },
  });

  assert.equal(entry.actorUserId, null);
  assert.deepEqual(entry.metadata, {
    providerId: "provider-3",
    protocol: "oidc",
    domain: "example.org",
  });
});
