import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test } from "vitest";
import { SSO_ERROR_CODES } from "./errors";
import {
  addOrganizationMember,
  bootSsoTestHarness,
  closeSsoTestHarness,
  createOrganization,
  readStoredProvider,
  signUpUser,
  type SsoTestClient,
  type SsoTestHarness,
  type SsoTestUser,
} from "./sso-test-helpers";

/**
 * End-to-end proof that the SSO registration guard enforces the multi-tenant
 * rules against the real `@better-auth/sso` register/update endpoints and a
 * migrated database: identity sources belong only to team organizations, a
 * domain is a private hostname no other organization already owns, a team is
 * capped at five providers, and SAML providers always store signed assertions.
 *
 * Organizations are seeded directly in SQL with explicit `kind` metadata
 * because migration mode skips the organization hooks that would tag it; this
 * mirrors the rows production writes.
 */

let harness: SsoTestHarness;
let ownerA: SsoTestUser;
let ownerB: SsoTestUser;
let memberA: SsoTestUser;
let orgA: string;
let orgB: string;
let orgP: string;

/** A unique private hostname that is neither public nor already claimed. */
function uniqueDomain() {
  return `${randomUUID().slice(0, 8)}.example`;
}

function oidcEndpoints() {
  return {
    authorizationEndpoint: "https://idp.example.com/authorize",
    tokenEndpoint: "https://idp.example.com/token",
    jwksEndpoint: "https://idp.example.com/jwks",
  };
}

/** Body for a skipDiscovery OIDC provider registration. */
function oidcRegistration(input: {
  organizationId?: string;
  domain: string;
  oidcConfig?: Record<string, unknown>;
}) {
  return {
    providerId: `guard-oidc-${randomUUID()}`,
    issuer: "https://idp.example.com",
    domain: input.domain,
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    oidcConfig: {
      clientId: "client-123",
      clientSecret: "s3cr3t",
      tokenEndpointAuthentication: "client_secret_basic",
      skipDiscovery: true,
      scopes: ["openid", "email"],
      ...oidcEndpoints(),
      ...input.oidcConfig,
    },
  };
}

async function registerOidc(
  client: SsoTestClient,
  input: {
    organizationId?: string;
    domain: string;
    oidcConfig?: Record<string, unknown>;
  },
) {
  const body = oidcRegistration(input);
  const response = await client.jsonRequest("/sso/register", body);
  return { response, providerId: body.providerId };
}

async function codeOf(response: Response): Promise<string | undefined> {
  const body = (await response.clone().json()) as { code?: string };
  return body.code;
}

beforeAll(async () => {
  harness = await bootSsoTestHarness("sso_guard");
  ownerA = await signUpUser(harness, "ownerA");
  ownerB = await signUpUser(harness, "ownerB");
  memberA = await signUpUser(harness, "memberA");

  orgA = await createOrganization(harness, {
    ownerUserId: ownerA.userId,
    kind: "team",
  });
  orgB = await createOrganization(harness, {
    ownerUserId: ownerB.userId,
    kind: "team",
  });
  orgP = await createOrganization(harness, {
    ownerUserId: ownerA.userId,
    kind: "personal",
  });
  await addOrganizationMember(harness, {
    organizationId: orgA,
    userId: memberA.userId,
    role: "member",
  });
}, 180_000);

afterAll(async () => {
  await closeSsoTestHarness(harness);
});

test("registration without an organization is rejected", async () => {
  const { response } = await registerOidc(ownerA.client, {
    domain: uniqueDomain(),
  });
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal(await codeOf(response), SSO_ERROR_CODES.organizationRequired);
}, 60_000);

test("registration against a personal organization is rejected", async () => {
  const { response } = await registerOidc(ownerA.client, {
    organizationId: orgP,
    domain: uniqueDomain(),
  });
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal(await codeOf(response), SSO_ERROR_CODES.organizationRequired);
}, 60_000);

test("a non-admin member cannot register a provider (plugin check)", async () => {
  const { response } = await registerOidc(memberA.client, {
    organizationId: orgA,
    domain: uniqueDomain(),
  });
  assert.equal(response.status, 403, await response.clone().text());
}, 60_000);

test("a public email domain is rejected", async () => {
  const { response } = await registerOidc(ownerA.client, {
    organizationId: orgA,
    domain: "gmail.com",
  });
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal(await codeOf(response), SSO_ERROR_CODES.domainNotAllowed);
}, 60_000);

// Shared by the uniqueness and update tests: org A owns acme.com.
let acmeProviderId: string;

test("a private domain registers, normalized and unverified", async () => {
  const { response, providerId } = await registerOidc(ownerA.client, {
    organizationId: orgA,
    domain: "ACME.com.",
  });
  assert.equal(response.status, 200, await response.clone().text());
  acmeProviderId = providerId;

  const stored = await readStoredProvider(harness, providerId);
  assert.equal(stored.domain, "acme.com");
  assert.equal(stored.domainVerified, false);
  assert.equal(stored.organizationId, orgA);
}, 60_000);

test("another organization cannot claim a domain already registered", async () => {
  const { response } = await registerOidc(ownerB.client, {
    organizationId: orgB,
    domain: "ACME.com.",
  });
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal(await codeOf(response), SSO_ERROR_CODES.domainNotAllowed);
}, 60_000);

test("a sixth provider for one organization is rejected", async () => {
  // Reuse ownerA (no fresh sign-up, which the auth rate limiter would reject)
  // in a dedicated team org so the count is this test's alone. The plugin's
  // per-user cap is 25, well above these five.
  const orgLimit = await createOrganization(harness, {
    ownerUserId: ownerA.userId,
    kind: "team",
  });

  for (let i = 0; i < 5; i += 1) {
    const { response } = await registerOidc(ownerA.client, {
      organizationId: orgLimit,
      domain: uniqueDomain(),
    });
    assert.equal(response.status, 200, await response.clone().text());
  }

  const { response } = await registerOidc(ownerA.client, {
    organizationId: orgLimit,
    domain: uniqueDomain(),
  });
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal(await codeOf(response), SSO_ERROR_CODES.providerLimit);
}, 120_000);

test("an OIDC endpoint resolving to a private host is rejected (plugin SSRF)", async () => {
  const { response } = await registerOidc(ownerA.client, {
    organizationId: orgA,
    domain: uniqueDomain(),
    oidcConfig: { discoveryEndpoint: "http://169.254.169.254/x" },
  });
  assert.ok(
    response.status >= 400 && response.status < 500,
    `expected a 4xx SSRF rejection, got ${response.status}: ${await response
      .clone()
      .text()}`,
  );
}, 60_000);

test("updating a provider domain to a public email domain is rejected", async () => {
  const response = await ownerA.client.jsonRequest("/sso/update-provider", {
    providerId: acmeProviderId,
    domain: "gmail.com",
  });
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal(await codeOf(response), SSO_ERROR_CODES.domainNotAllowed);
}, 60_000);

test("updating a provider domain to one owned by another organization is rejected", async () => {
  const bravoDomain = uniqueDomain();
  const registered = await registerOidc(ownerB.client, {
    organizationId: orgB,
    domain: bravoDomain,
  });
  assert.equal(
    registered.response.status,
    200,
    await registered.response.clone().text(),
  );

  const response = await ownerA.client.jsonRequest("/sso/update-provider", {
    providerId: acmeProviderId,
    domain: bravoDomain,
  });
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal(await codeOf(response), SSO_ERROR_CODES.domainNotAllowed);
}, 60_000);

test("a SAML provider always stores signed assertions", async () => {
  const providerId = `guard-saml-${randomUUID()}`;
  const response = await ownerA.client.jsonRequest("/sso/register", {
    providerId,
    issuer: "https://idp.example.com/saml",
    domain: uniqueDomain(),
    organizationId: orgA,
    samlConfig: {
      entryPoint: "https://idp.example.com/saml/sso",
      cert: "-----BEGIN CERTIFICATE-----\nMIIBdummycertificatevalue==\n-----END CERTIFICATE-----",
      idpMetadata: { entityID: "https://idp.example.com/saml/metadata" },
      wantAssertionsSigned: false,
    },
  });
  assert.equal(response.status, 200, await response.clone().text());

  const stored = await readStoredProvider(harness, providerId);
  assert.ok(stored.samlConfig, "expected a stored samlConfig");
  const samlConfig = JSON.parse(stored.samlConfig) as {
    wantAssertionsSigned?: boolean;
  };
  assert.equal(samlConfig.wantAssertionsSigned, true);
}, 60_000);
