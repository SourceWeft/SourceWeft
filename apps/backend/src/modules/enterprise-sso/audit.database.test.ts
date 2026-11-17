import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { register } from "node:module";
import { afterAll, beforeAll, test } from "vitest";
import {
  bootSsoTestHarness,
  closeSsoTestHarness,
  createOrganization,
  signUpUser,
  SsoTestClient,
  type SsoTestHarness,
  type SsoTestUser,
} from "./sso-test-helpers";

/**
 * Proves `guard-plugin.ts`'s `hooks.after` (see `./audit.ts`) records a team
 * audit log entry for each successful SSO provider change, with metadata
 * limited to `{ providerId, protocol, domain }` — never a secret, cert,
 * claim or attribute value — and records nothing for a call the plugin or
 * the guard rejects.
 *
 * `/sso/verify-domain` performs a real DNS TXT lookup, resolved by a
 * `dns = await import("node:dns/promises")` inside `@better-auth/sso`'s own
 * bundled `dist/index.mjs`. Stubbing that deterministically turned out to
 * need more than a bare `vi.mock("node:dns/promises", ...)`:
 *
 *  - `vi.mock` never reached that dynamic import — verified empirically, it
 *    still hit the real resolver and failed with `ENOTFOUND`, regardless of
 *    whether `@better-auth/sso` was forced into Vitest's SSR transform via
 *    `server.deps.inline` (also verified empirically).
 *  - `node:dns/promises`'s ES module namespace is not writable either:
 *    `dns.resolveTxt = ...` on an `import()`-obtained namespace is a silent
 *    no-op (verified empirically), and mutating the CJS module-registry
 *    object `createRequire(...)("node:dns/promises")` returns does NOT reach
 *    it: once this test file's auth harness boots, a fresh
 *    `await import("node:dns/promises")` resolves to a *different*
 *    `resolveTxt` function than the CJS-required object holds (verified
 *    empirically — something in the boot path, most likely
 *    require-in-the-middle-style instrumentation patching `require("dns/*")`
 *    without the native ESM binding ever seeing it) — so neither `require`
 *    nor Vite's module graph can reach the function `import()` actually
 *    calls.
 *
 * What does sit below all of that is Node's own module customization hooks
 * (`node:module`'s `register`), which govern every `import()` resolution in
 * the process regardless of CJS/ESM interop or Vite's transform boundary.
 * `./dns-txt-mock-loader.mjs` redirects the `node:dns/promises` specifier to
 * a tiny synthetic module whose `resolveTxt` reads
 * `globalThis.__ssoAuditDnsResolveTxt` at call time, so the two
 * DNS-dependent tests below install/clear that flag instead of mocking a
 * module reference.
 */
register(new URL("./dns-txt-mock-loader.mjs", import.meta.url));

declare global {
  var __ssoAuditDnsResolveTxt:
    | ((...args: unknown[]) => Promise<string[][]>)
    | undefined;
}

let harness: SsoTestHarness;
let owner: SsoTestUser;
let teamId: string;

function uniqueDomain() {
  return `${randomUUID().slice(0, 8)}.example`;
}

function oidcEndpoints() {
  return {
    authorizationEndpoint: "https://idp.example.com/authorize",
    tokenEndpoint: "https://93.184.216.34/token",
    jwksEndpoint: "https://93.184.216.34/jwks",
  };
}

async function registerOidc(
  client: SsoTestClient,
  input: { organizationId: string; domain: string },
) {
  const providerId = `audit-oidc-${randomUUID()}`;
  const response = await client.jsonRequest("/sso/register", {
    providerId,
    issuer: "https://idp.example.com",
    domain: input.domain,
    organizationId: input.organizationId,
    oidcConfig: {
      clientId: "client-123",
      clientSecret: "s3cr3t",
      tokenEndpointAuthentication: "client_secret_basic",
      skipDiscovery: true,
      scopes: ["openid", "email"],
      ...oidcEndpoints(),
    },
  });
  return { response, providerId };
}

async function registerSaml(
  client: SsoTestClient,
  input: { organizationId: string; domain: string },
) {
  const providerId = `audit-saml-${randomUUID()}`;
  const response = await client.jsonRequest("/sso/register", {
    providerId,
    issuer: "https://idp.example.com/saml",
    domain: input.domain,
    organizationId: input.organizationId,
    samlConfig: {
      entryPoint: "https://idp.example.com/saml/sso",
      cert: "-----BEGIN CERTIFICATE-----\nMIIBdummycertificatevalue==\n-----END CERTIFICATE-----",
      idpMetadata: { entityID: "https://idp.example.com/saml/metadata" },
      wantAssertionsSigned: false,
    },
  });
  return { response, providerId };
}

async function listTeamAudit(input: { teamId: string }) {
  const { teamAuditService } = await import("../team-audit");
  return teamAuditService.list(input);
}

async function codeOf(response: Response): Promise<string | undefined> {
  const body = (await response.clone().json()) as { code?: string };
  return body.code;
}

beforeAll(async () => {
  harness = await bootSsoTestHarness("sso_audit");
  owner = await signUpUser(harness, "auditOwner");
  teamId = await createOrganization(harness, {
    ownerUserId: owner.userId,
    kind: "team",
  });
}, 600_000);

afterAll(async () => {
  await closeSsoTestHarness(harness);
});

test("registering a provider records sso.provider_created with providerId/protocol/domain only", async () => {
  const domain = uniqueDomain();
  const { response, providerId } = await registerOidc(owner.client, {
    organizationId: teamId,
    domain,
  });
  assert.equal(response.status, 200, await response.clone().text());

  const entries = await listTeamAudit({ teamId });
  const entry = entries.find(
    (e) => e.action === "sso.provider_created" && e.targetId === providerId,
  );
  assert.ok(entry, "expected a sso.provider_created entry");
  assert.equal(entry!.targetType, "sso_provider");
  assert.equal(entry!.actorUserId, owner.userId);
  assert.deepEqual(entry!.metadata, {
    providerId,
    protocol: "oidc",
    domain,
  });
  const serialized = JSON.stringify(entry!.metadata);
  assert.equal(serialized.includes("clientSecret"), false);
  assert.equal(serialized.includes("s3cr3t"), false);
  assert.equal(serialized.includes("cert"), false);
}, 200_000);

test("registering a SAML provider records protocol saml, never the certificate", async () => {
  const domain = uniqueDomain();
  const { response, providerId } = await registerSaml(owner.client, {
    organizationId: teamId,
    domain,
  });
  assert.equal(response.status, 200, await response.clone().text());

  const entries = await listTeamAudit({ teamId });
  const entry = entries.find(
    (e) => e.action === "sso.provider_created" && e.targetId === providerId,
  );
  assert.ok(entry, "expected a sso.provider_created entry");
  assert.deepEqual(entry!.metadata, {
    providerId,
    protocol: "saml",
    domain,
  });
  const serialized = JSON.stringify(entry!.metadata);
  assert.equal(serialized.includes("BEGIN CERTIFICATE"), false);
  assert.equal(serialized.includes("entryPoint"), false);
}, 200_000);

test("updating a provider records sso.provider_updated with the current domain/protocol", async () => {
  const domain = uniqueDomain();
  const { response: registerResponse, providerId } = await registerOidc(
    owner.client,
    { organizationId: teamId, domain },
  );
  assert.equal(registerResponse.status, 200, await registerResponse.clone().text());

  const updatedIssuer = "https://idp-updated.example.com";
  const response = await owner.client.jsonRequest("/sso/update-provider", {
    providerId,
    issuer: updatedIssuer,
  });
  assert.equal(response.status, 200, await response.clone().text());

  const entries = await listTeamAudit({ teamId });
  const entry = entries.find(
    (e) => e.action === "sso.provider_updated" && e.targetId === providerId,
  );
  assert.ok(entry, "expected a sso.provider_updated entry");
  assert.equal(entry!.actorUserId, owner.userId);
  assert.deepEqual(entry!.metadata, {
    providerId,
    protocol: "oidc",
    domain,
  });
}, 200_000);

test("deleting a provider records sso.provider_deleted with the domain/protocol it had", async () => {
  const domain = uniqueDomain();
  const { response: registerResponse, providerId } = await registerOidc(
    owner.client,
    { organizationId: teamId, domain },
  );
  assert.equal(registerResponse.status, 200, await registerResponse.clone().text());

  const response = await owner.client.jsonRequest("/sso/delete-provider", {
    providerId,
  });
  assert.equal(response.status, 200, await response.clone().text());

  const entries = await listTeamAudit({ teamId });
  const entry = entries.find(
    (e) => e.action === "sso.provider_deleted" && e.targetId === providerId,
  );
  assert.ok(entry, "expected a sso.provider_deleted entry");
  assert.equal(entry!.actorUserId, owner.userId);
  assert.deepEqual(entry!.metadata, {
    providerId,
    protocol: "oidc",
    domain,
  });
}, 200_000);

test("verifying a domain records sso.domain_verified, with DNS stubbed deterministically", async () => {
  const domain = uniqueDomain();
  const { response: registerResponse, providerId } = await registerOidc(
    owner.client,
    { organizationId: teamId, domain },
  );
  assert.equal(registerResponse.status, 200, await registerResponse.clone().text());
  const registered = (await registerResponse.clone().json()) as {
    domainVerificationToken?: string;
  };
  assert.ok(
    registered.domainVerificationToken,
    "expected domainVerification to be enabled and return a token",
  );

  const token = registered.domainVerificationToken!;
  globalThis.__ssoAuditDnsResolveTxt = async () => [[token]];

  let response: Response;
  try {
    response = await owner.client.jsonRequest("/sso/verify-domain", {
      providerId,
    });
  } finally {
    delete globalThis.__ssoAuditDnsResolveTxt;
  }
  assert.equal(response.status, 204, await response.clone().text());

  const entries = await listTeamAudit({ teamId });
  const entry = entries.find(
    (e) => e.action === "sso.domain_verified" && e.targetId === providerId,
  );
  assert.ok(entry, "expected a sso.domain_verified entry");
  assert.equal(entry!.actorUserId, owner.userId);
  assert.deepEqual(entry!.metadata, {
    providerId,
    protocol: "oidc",
    domain,
  });
}, 200_000);

test("a registration rejected by the guard (SSO_DOMAIN_NOT_ALLOWED) records nothing", async () => {
  const rejectedTeam = await createOrganization(harness, {
    ownerUserId: owner.userId,
    kind: "team",
  });
  const { response } = await registerOidc(owner.client, {
    organizationId: rejectedTeam,
    domain: "gmail.com",
  });
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal(await codeOf(response), "SSO_DOMAIN_NOT_ALLOWED");

  const entries = await listTeamAudit({ teamId: rejectedTeam });
  assert.deepEqual(entries, []);
}, 200_000);
