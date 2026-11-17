import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { APIError, isAPIError } from "better-auth/api";
import { afterAll, beforeAll, test } from "vitest";
import { SSO_ERROR_CODES } from "./errors";
import { VERIFIED_DOMAIN_UNIQUE_INDEX } from "./guard-plugin";
import {
  addOrganizationMember,
  bootSsoTestHarness,
  closeSsoTestHarness,
  createOrganization,
  insertOrphanProvider,
  readStoredProvider,
  setProviderDomainVerified,
  signUpUser,
  SsoTestClient,
  type SsoTestHarness,
  type SsoTestUser,
} from "./sso-test-helpers";

/**
 * End-to-end proof of the SSO tenant guard against the real `@better-auth/sso`
 * endpoints and a migrated database:
 *
 *  - identity sources belong only to team organizations;
 *  - a domain is private, unique within its org, and — across orgs — only a
 *    VERIFIED provider owns it (an unverified squatter does not block others);
 *  - a verified domain cannot be re-verified by another org, backed by a partial
 *    unique index;
 *  - email sign-in routes to the exact verified provider, else the nearest
 *    verified parent, making squatter rows invisible;
 *  - a team is capped at five providers; SAML stores signed assertions;
 *  - an organization-less provider can never be updated or deleted.
 *
 * Organizations are seeded in SQL with explicit `kind` metadata because
 * migration mode runs no org hooks; this mirrors the rows production writes.
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
    // authorizationEndpoint carries the client_id and is excluded from the
    // sign-in SSRF re-check, so its FQDN is fine. tokenEndpoint/jwksEndpoint ARE
    // re-checked at sign-in by DNS-resolving the host; under a local fake-IP DNS
    // a FQDN resolves to a private address and the sign-in 400s, so use a public
    // IP literal (IP literals skip DNS; no request is ever made to these).
    authorizationEndpoint: "https://idp.example.com/authorize",
    tokenEndpoint: "https://93.184.216.34/token",
    jwksEndpoint: "https://93.184.216.34/jwks",
  };
}

function oidcRegistration(input: {
  organizationId?: string;
  domain: string;
  clientId?: string;
  oidcConfig?: Record<string, unknown>;
}) {
  return {
    providerId: `guard-oidc-${randomUUID()}`,
    issuer: "https://idp.example.com",
    domain: input.domain,
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    oidcConfig: {
      clientId: input.clientId ?? "client-123",
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
    clientId?: string;
    oidcConfig?: Record<string, unknown>;
  },
) {
  const body = oidcRegistration(input);
  // A fresh IP per call: this suite reuses one admin client across many
  // registrations, which would otherwise exhaust `/sso/register`'s per-IP
  // rate limit (task 7) well before any test's own assertions are reached.
  const response = await client.withFreshIp().jsonRequest("/sso/register", body);
  return { response, providerId: body.providerId };
}

/** Register a verified provider (via SQL) and return its providerId. */
async function registerVerified(
  client: SsoTestClient,
  input: { organizationId: string; domain: string; clientId: string },
) {
  const { response, providerId } = await registerOidc(client, input);
  assert.equal(response.status, 200, await response.clone().text());
  await setProviderDomainVerified(harness, providerId);
  return providerId;
}

async function codeOf(response: Response): Promise<string | undefined> {
  const body = (await response.clone().json()) as { code?: string };
  return body.code;
}

/** POST /sign-in/sso as an anonymous caller. */
async function signInByEmail(email: string) {
  const client = new SsoTestClient(harness.auth, harness.baseUrl);
  return client.jsonRequest("/sign-in/sso", {
    email,
    callbackURL: "https://app.example.com/after",
  });
}

/** POST /sign-in/sso with only an organizationSlug. */
async function signInBySlug(organizationSlug: string) {
  const client = new SsoTestClient(harness.auth, harness.baseUrl);
  return client.jsonRequest("/sign-in/sso", {
    organizationSlug,
    callbackURL: "https://app.example.com/after",
  });
}

/** The slug createOrganization stamped on an org. */
async function orgSlug(organizationId: string): Promise<string> {
  const result = await harness.schema.database.query<{ slug: string }>(
    `select slug from organization where id = $1`,
    [organizationId],
  );
  const slug = result.rows[0]?.slug;
  assert.ok(slug, `expected a slug for ${organizationId}`);
  return slug;
}

/** The client_id query param of the authorization URL a sign-in redirects to. */
async function routedClientId(response: Response): Promise<string | null> {
  const body = (await response.clone().json()) as { url?: string };
  assert.ok(body.url, `expected a redirect url, got ${await response.clone().text()}`);
  return new URL(body.url).searchParams.get("client_id");
}

beforeAll(async () => {
  harness = await bootSsoTestHarness("sso_guard");
  ownerA = await signUpUser(harness, "ownerA");
  ownerB = await signUpUser(harness, "ownerB");
  memberA = await signUpUser(harness, "memberA");

  orgA = await createOrganization(harness, { ownerUserId: ownerA.userId, kind: "team" });
  orgB = await createOrganization(harness, { ownerUserId: ownerB.userId, kind: "team" });
  orgP = await createOrganization(harness, { ownerUserId: ownerA.userId, kind: "personal" });
  await addOrganizationMember(harness, {
    organizationId: orgA,
    userId: memberA.userId,
    role: "member",
  });
}, 600_000);

afterAll(async () => {
  await closeSsoTestHarness(harness);
});

test("registration without an organization is rejected", async () => {
  const { response } = await registerOidc(ownerA.client, { domain: uniqueDomain() });
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal(await codeOf(response), SSO_ERROR_CODES.organizationRequired);
}, 200_000);

test("registration against a personal organization is rejected", async () => {
  const { response } = await registerOidc(ownerA.client, {
    organizationId: orgP,
    domain: uniqueDomain(),
  });
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal(await codeOf(response), SSO_ERROR_CODES.organizationRequired);
}, 200_000);

test("a non-admin member cannot register a provider (plugin check)", async () => {
  const { response } = await registerOidc(memberA.client, {
    organizationId: orgA,
    domain: uniqueDomain(),
  });
  assert.equal(response.status, 403, await response.clone().text());
}, 200_000);

test("a public email domain is rejected", async () => {
  const { response } = await registerOidc(ownerA.client, {
    organizationId: orgA,
    domain: "gmail.com",
  });
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal(await codeOf(response), SSO_ERROR_CODES.domainNotAllowed);
}, 200_000);

// Org A owns acme.com; shared by the uniqueness, verification and update tests.
let acmeProviderId: string;
// Org B's unverified acme.com claim (allowed while A's is unverified).
let bAcmeProviderId: string;

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
}, 200_000);

test("another org may claim the same domain while it is unverified", async () => {
  const { response, providerId } = await registerOidc(ownerB.client, {
    organizationId: orgB,
    domain: "acme.com",
  });
  assert.equal(response.status, 200, await response.clone().text());
  bAcmeProviderId = providerId;
}, 200_000);

test("a second provider for the same domain in the same org is rejected", async () => {
  const { response } = await registerOidc(ownerA.client, {
    organizationId: orgA,
    domain: "acme.com",
  });
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal(await codeOf(response), SSO_ERROR_CODES.domainNotAllowed);
}, 200_000);

test("once a domain is verified, another org cannot register it", async () => {
  // Verify org A's acme.com (direct SQL stands in for passing DNS).
  await setProviderDomainVerified(harness, acmeProviderId);

  const freshOrgB = await createOrganization(harness, {
    ownerUserId: ownerB.userId,
    kind: "team",
  });
  const { response } = await registerOidc(ownerB.client, {
    organizationId: freshOrgB,
    domain: "acme.com",
  });
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal(await codeOf(response), SSO_ERROR_CODES.domainNotAllowed);
}, 200_000);

test("verify-domain is rejected when another org already verified the domain", async () => {
  const response = await ownerB.client.jsonRequest("/sso/verify-domain", {
    providerId: bAcmeProviderId,
  });
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal(await codeOf(response), SSO_ERROR_CODES.domainNotAllowed);
}, 200_000);

test("the partial unique index forbids a second verified row for one domain", async () => {
  await assert.rejects(
    () => setProviderDomainVerified(harness, bAcmeProviderId),
    (error: { code?: string }) => error.code === "23505",
  );
}, 200_000);

test("a verified-domain conflict surfaces as a clean 400 through the wrapped adapter", async () => {
  // Two unverified providers for one domain in different orgs, then verify one.
  const domain = uniqueDomain();
  const orgOwner = await createOrganization(harness, {
    ownerUserId: ownerA.userId,
    kind: "team",
  });
  const orgOther = await createOrganization(harness, {
    ownerUserId: ownerB.userId,
    kind: "team",
  });
  const owned = await registerOidc(ownerA.client, { organizationId: orgOwner, domain });
  assert.equal(owned.response.status, 200, await owned.response.clone().text());
  const other = await registerOidc(ownerB.client, { organizationId: orgOther, domain });
  assert.equal(other.response.status, 200, await other.response.clone().text());
  await setProviderDomainVerified(harness, owned.providerId);

  const idRow = await harness.schema.database.query<{ id: string }>(
    `select id from "ssoProvider" where "providerId" = $1`,
    [other.providerId],
  );
  const otherId = idRow.rows[0]?.id;
  assert.ok(otherId);

  // The adapter the plugin actually uses: secret-storage- then guard-wrapped.
  const adapter = (await harness.auth.$context).adapter as unknown as {
    incrementOne: (args: unknown) => Promise<unknown>;
    transaction: <R>(
      cb: (trx: { incrementOne: (args: unknown) => Promise<unknown> }) => Promise<R>,
    ) => Promise<R>;
  };
  // The exact call the plugin's completeDomainVerification makes.
  const increment = {
    model: "ssoProvider",
    where: [
      { field: "id", value: otherId },
      { field: "domain", value: domain },
    ],
    increment: {},
    set: { domainVerified: true },
  };

  // Direct (non-transaction) path — proves the real error shape triggers the map.
  const direct = await adapter.incrementOne(increment).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(isAPIError(direct), `expected an APIError, got ${String(direct)}`);
  assert.equal((direct as APIError).statusCode, 400);
  assert.equal((direct as APIError).body?.code, SSO_ERROR_CODES.domainNotAllowed);
  // Pin the real surfaced DB error (a PostgreSQL unique violation) that the
  // mapping keys off, so the unit test's fixture stays faithful to it.
  const cause = (direct as { cause?: { code?: string; constraint?: string } })
    .cause;
  assert.equal(cause?.code, "23505");
  assert.equal(cause?.constraint, VERIFIED_DOMAIN_UNIQUE_INDEX);

  // Same violation inside a transaction maps identically (the wrapper re-wraps
  // the transaction adapter).
  const inTx = await adapter
    .transaction((trx) => trx.incrementOne(increment))
    .then(
      () => null,
      (error: unknown) => error,
    );
  assert.ok(isAPIError(inTx), `expected an APIError from the tx path, got ${String(inTx)}`);
  assert.equal((inTx as APIError).statusCode, 400);
  assert.equal((inTx as APIError).body?.code, SSO_ERROR_CODES.domainNotAllowed);

  // The second row is still unverified after both rejected attempts.
  const after = await readStoredProvider(harness, other.providerId);
  assert.equal(after.domainVerified, false);
}, 200_000);

test("a sixth provider for one organization is rejected", async () => {
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
}, 300_000);

test("an OIDC endpoint resolving to a private host is rejected (plugin SSRF)", async () => {
  const { response } = await registerOidc(ownerA.client, {
    organizationId: orgA,
    domain: uniqueDomain(),
    oidcConfig: { discoveryEndpoint: "http://169.254.169.254/x" },
  });
  assert.ok(
    response.status >= 400 && response.status < 500,
    `expected a 4xx SSRF rejection, got ${response.status}`,
  );
}, 200_000);

test("updating a provider domain to a public email domain is rejected", async () => {
  const response = await ownerA.client.jsonRequest("/sso/update-provider", {
    providerId: acmeProviderId,
    domain: "gmail.com",
  });
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal(await codeOf(response), SSO_ERROR_CODES.domainNotAllowed);
}, 200_000);

test("updating a provider domain to one VERIFIED by another org is rejected", async () => {
  const charlie = uniqueDomain();
  await registerVerified(ownerB.client, {
    organizationId: orgB,
    domain: charlie,
    clientId: "cid-charlie",
  });

  const response = await ownerA.client.jsonRequest("/sso/update-provider", {
    providerId: acmeProviderId,
    domain: charlie,
  });
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal(await codeOf(response), SSO_ERROR_CODES.domainNotAllowed);
}, 200_000);

test("a SAML provider always stores signed assertions", async () => {
  const providerId = `guard-saml-${randomUUID()}`;
  const response = await ownerA.client.withFreshIp().jsonRequest("/sso/register", {
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
}, 200_000);

// guardProviderMutation: an organization-less provider is immutable.
let orphanProviderId: string;

test("an organization-less provider cannot be updated", async () => {
  orphanProviderId = await insertOrphanProvider(harness, {
    userId: ownerA.userId,
    domain: uniqueDomain(),
  });
  const response = await ownerA.client.jsonRequest("/sso/update-provider", {
    providerId: orphanProviderId,
    issuer: "https://updated.example.com",
  });
  assert.ok(response.status >= 400, await response.clone().text());

  const stored = await readStoredProvider(harness, orphanProviderId);
  assert.equal(stored.organizationId, null);
  // issuer was not changed by the rejected update.
  const row = await harness.schema.database.query<{ issuer: string }>(
    `select issuer from "ssoProvider" where "providerId" = $1`,
    [orphanProviderId],
  );
  assert.equal(row.rows[0]?.issuer, "https://orphan.example.com");
}, 200_000);

test("an organization-less provider cannot be deleted", async () => {
  const response = await ownerA.client.jsonRequest("/sso/delete-provider", {
    providerId: orphanProviderId,
  });
  assert.ok(response.status >= 400, await response.clone().text());

  const row = await harness.schema.database.query(
    `select 1 from "ssoProvider" where "providerId" = $1`,
    [orphanProviderId],
  );
  assert.equal(row.rows.length, 1, "the org-less provider must still exist");
}, 200_000);

// Email sign-in routing. Register the squatter before verifying the real
// provider, since a verified domain blocks a later unverified claim.
test("email sign-in routes to the verified provider, not an unverified squatter", async () => {
  const orgSquatter = await createOrganization(harness, {
    ownerUserId: ownerB.userId,
    kind: "team",
  });
  const orgReal = await createOrganization(harness, {
    ownerUserId: ownerA.userId,
    kind: "team",
  });
  const squatter = await registerOidc(ownerB.client, {
    organizationId: orgSquatter,
    domain: "corp.example",
    clientId: "cid-corp-squatter",
  });
  assert.equal(squatter.response.status, 200, await squatter.response.clone().text());
  await registerVerified(ownerA.client, {
    organizationId: orgReal,
    domain: "corp.example",
    clientId: "cid-corp",
  });

  const response = await signInByEmail("user@corp.example");
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(await routedClientId(response), "cid-corp");
}, 300_000);

test("email sign-in prefers an exact verified subdomain over its parent", async () => {
  const orgSub = await createOrganization(harness, {
    ownerUserId: ownerB.userId,
    kind: "team",
  });
  await registerVerified(ownerB.client, {
    organizationId: orgSub,
    domain: "mail.corp.example",
    clientId: "cid-mail-corp",
  });

  const response = await signInByEmail("user@mail.corp.example");
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(await routedClientId(response), "cid-mail-corp");
}, 300_000);

test("email sign-in falls back to the nearest verified parent domain", async () => {
  const orgParent = await createOrganization(harness, {
    ownerUserId: ownerA.userId,
    kind: "team",
  });
  await registerVerified(ownerA.client, {
    organizationId: orgParent,
    domain: "beta.example",
    clientId: "cid-beta",
  });

  const response = await signInByEmail("user@mail.beta.example");
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(await routedClientId(response), "cid-beta");
}, 300_000);

test("email sign-in with no verified match is a 404", async () => {
  const response = await signInByEmail("user@nobody.example");
  assert.equal(response.status, 404, await response.clone().text());
  assert.equal(await codeOf(response), SSO_ERROR_CODES.providerNotFound);
}, 200_000);

test("email sign-in with a public email domain is a 404", async () => {
  const response = await signInByEmail("user@gmail.com");
  assert.equal(response.status, 404, await response.clone().text());
  assert.equal(await codeOf(response), SSO_ERROR_CODES.providerNotFound);
}, 200_000);

// ── Public suffixes (R6) ────────────────────────────────────────────────────

test("a bare public suffix is rejected at registration, including a PRIVATE one", async () => {
  for (const domain of ["co.uk", "github.io", "herokuapp.com", "blogspot.com"]) {
    const { response } = await registerOidc(ownerA.client, { organizationId: orgA, domain });
    assert.equal(response.status, 400, `${domain}: ${await response.clone().text()}`);
    assert.equal(await codeOf(response), SSO_ERROR_CODES.domainNotAllowed);
  }
}, 200_000);

test("a registrable domain under a private suffix is accepted", async () => {
  const org = await createOrganization(harness, { ownerUserId: ownerA.userId, kind: "team" });
  for (const domain of ["acme.co.uk", "acme.github.io"]) {
    const { response } = await registerOidc(ownerA.client, { organizationId: org, domain });
    assert.equal(response.status, 200, `${domain}: ${await response.clone().text()}`);
  }
}, 200_000);

// ── Provider id shape (R7) ──────────────────────────────────────────────────

test("a provider id outside ^[a-z0-9-]{3,47}$ is rejected", async () => {
  for (const providerId of [
    "ab",
    "a".repeat(48),
    "Has-Upper",
    "has.dot",
    "under_score",
    "white space",
  ]) {
    const response = await ownerA.client.withFreshIp().jsonRequest("/sso/register", {
      ...oidcRegistration({ organizationId: orgA, domain: uniqueDomain() }),
      providerId,
    });
    assert.equal(response.status, 400, `${providerId}: ${await response.clone().text()}`);
    assert.equal(await codeOf(response), SSO_ERROR_CODES.invalidProviderId);
  }
}, 200_000);

// ── Slug-based sign-in routing (R8) ─────────────────────────────────────────

test("sign-in by slug routes to the org's single verified provider", async () => {
  const org = await createOrganization(harness, { ownerUserId: ownerA.userId, kind: "team" });
  await registerVerified(ownerA.client, {
    organizationId: org,
    domain: uniqueDomain(),
    clientId: "cid-slug-one",
  });
  const response = await signInBySlug(await orgSlug(org));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(await routedClientId(response), "cid-slug-one");
}, 300_000);

test("sign-in by slug routes to the verified provider when a pending one also exists", async () => {
  const org = await createOrganization(harness, { ownerUserId: ownerA.userId, kind: "team" });
  await registerVerified(ownerA.client, {
    organizationId: org,
    domain: uniqueDomain(),
    clientId: "cid-slug-verified",
  });
  const pending = await registerOidc(ownerA.client, {
    organizationId: org,
    domain: uniqueDomain(),
    clientId: "cid-slug-pending",
  });
  assert.equal(pending.response.status, 200, await pending.response.clone().text());
  const response = await signInBySlug(await orgSlug(org));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(await routedClientId(response), "cid-slug-verified");
}, 300_000);

test("sign-in by slug with two verified providers is a 404", async () => {
  const org = await createOrganization(harness, { ownerUserId: ownerA.userId, kind: "team" });
  await registerVerified(ownerA.client, {
    organizationId: org,
    domain: uniqueDomain(),
    clientId: "cid-slug-two-a",
  });
  await registerVerified(ownerA.client, {
    organizationId: org,
    domain: uniqueDomain(),
    clientId: "cid-slug-two-b",
  });
  const response = await signInBySlug(await orgSlug(org));
  assert.equal(response.status, 404, await response.clone().text());
  assert.equal(await codeOf(response), SSO_ERROR_CODES.providerNotFound);
}, 300_000);

test("sign-in by slug with no verified provider is a 404", async () => {
  const org = await createOrganization(harness, { ownerUserId: ownerA.userId, kind: "team" });
  const pending = await registerOidc(ownerA.client, {
    organizationId: org,
    domain: uniqueDomain(),
  });
  assert.equal(pending.response.status, 200, await pending.response.clone().text());
  const response = await signInBySlug(await orgSlug(org));
  assert.equal(response.status, 404, await response.clone().text());
  assert.equal(await codeOf(response), SSO_ERROR_CODES.providerNotFound);
}, 200_000);

test("sign-in by an unknown slug is a 404", async () => {
  const response = await signInBySlug("team-does-not-exist");
  assert.equal(response.status, 404, await response.clone().text());
  assert.equal(await codeOf(response), SSO_ERROR_CODES.providerNotFound);
}, 200_000);

// ── The guard runs for EVERY caller; the plugin still 401s the unauthenticated ─

test("an unauthenticated register with a valid body reaches the plugin's 401", async () => {
  // A valid private domain passes every guard rule, so the request reaches the
  // plugin's sessionMiddleware, which answers 401 for the missing session.
  const client = new SsoTestClient(harness.auth, harness.baseUrl);
  const response = await client.jsonRequest(
    "/sso/register",
    oidcRegistration({ organizationId: orgA, domain: uniqueDomain() }),
  );
  assert.equal(response.status, 401, await response.clone().text());
}, 200_000);

// ── A (CRITICAL): the guard must not be skippable by how a caller authenticates ─

/** A signed session token exposed by the bearer plugin after a sign-in. */
async function bearerTokenFor(user: SsoTestUser): Promise<string> {
  const client = new SsoTestClient(harness.auth, harness.baseUrl);
  const response = await client.jsonRequest("/sign-in/email", {
    email: user.email,
    password: "correct horse battery staple",
  });
  assert.equal(response.status, 200, await response.clone().text());
  const token = response.headers.get("set-auth-token");
  assert.ok(token, "expected a set-auth-token header from the bearer plugin");
  return token;
}

/** A user-scoped API key for the owner, authenticated via the x-api-key header. */
async function userApiKeyFor(user: SsoTestUser): Promise<string> {
  const response = await user.client.withFreshIp().jsonRequest("/api-key/create", {
    configId: "user",
    name: `guard-${randomUUID().slice(0, 8)}`,
  });
  assert.equal(response.status, 200, await response.clone().text());
  const body = (await response.json()) as { key?: string };
  assert.ok(body.key, "expected an API key");
  return body.key;
}

/** A request carrying ONLY the given header (no cookie), as a fresh client. */
async function registerWithHeader(
  header: Record<string, string>,
  body: Record<string, unknown>,
) {
  return new SsoTestClient(harness.auth, harness.baseUrl).jsonRequest(
    "/sso/register",
    body,
    { headers: header },
  );
}

test("a bearer-authenticated caller cannot skip the guard rules", async () => {
  const token = await bearerTokenFor(ownerA);
  const header = { Authorization: `Bearer ${token}` };

  const gmail = await registerWithHeader(
    header,
    oidcRegistration({ organizationId: orgA, domain: "gmail.com" }),
  );
  assert.equal(gmail.status, 400, await gmail.clone().text());
  assert.equal(await codeOf(gmail), SSO_ERROR_CODES.domainNotAllowed);

  const github = await registerWithHeader(
    header,
    oidcRegistration({ organizationId: orgA, domain: "github.io" }),
  );
  assert.equal(github.status, 400, await github.clone().text());
  assert.equal(await codeOf(github), SSO_ERROR_CODES.domainNotAllowed);

  const longId = await registerWithHeader(header, {
    ...oidcRegistration({ organizationId: orgA, domain: uniqueDomain() }),
    providerId: "a".repeat(60),
  });
  assert.equal(longId.status, 400, await longId.clone().text());
  assert.equal(await codeOf(longId), SSO_ERROR_CODES.invalidProviderId);

  const personal = await registerWithHeader(
    header,
    oidcRegistration({ organizationId: orgP, domain: uniqueDomain() }),
  );
  assert.equal(personal.status, 400, await personal.clone().text());
  assert.equal(await codeOf(personal), SSO_ERROR_CODES.organizationRequired);

  // An update to a public domain, via bearer, is still rejected.
  const update = await new SsoTestClient(harness.auth, harness.baseUrl).jsonRequest(
    "/sso/update-provider",
    { providerId: acmeProviderId, domain: "gmail.com" },
    { headers: header },
  );
  assert.equal(update.status, 400, await update.clone().text());
  assert.equal(await codeOf(update), SSO_ERROR_CODES.domainNotAllowed);
}, 300_000);

test("an API-key-authenticated caller cannot skip the guard rules either", async () => {
  const key = await userApiKeyFor(ownerA);
  const gmail = await registerWithHeader(
    { "x-api-key": key },
    oidcRegistration({ organizationId: orgA, domain: "gmail.com" }),
  );
  assert.equal(gmail.status, 400, await gmail.clone().text());
  assert.equal(await codeOf(gmail), SSO_ERROR_CODES.domainNotAllowed);
}, 200_000);
