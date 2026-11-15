import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { afterAll, beforeAll, test } from "vitest";
import { config } from "../../shared/config";
import {
  createSamlIdpFixture,
  SAML_SIGNATURE_ALGORITHMS,
  type SamlIdpFixture,
  type SamlResponseInput,
} from "../../test/saml-fixture";
import { SSO_ERROR_CODES } from "./errors";
import {
  bootSsoTestHarness,
  closeSsoTestHarness,
  createOrganization,
  readStoredProvider,
  setProviderDomainVerified,
  setProviderRoleMapping,
  signUpUser,
  SsoTestClient,
  type SsoTestHarness,
  type SsoTestUser,
} from "./sso-test-helpers";

/**
 * End-to-end proof of SAML sign-in against the real `@better-auth/sso` SAML flow
 * (SP-initiated `POST /sign-in/sso` → fixture-signed Response POSTed to
 * `POST /sso/saml2/sp/acs/:providerId`), a `samlify`-backed IdP fixture
 * (see ../../test/saml-fixture.ts) and a migrated database booted in RUNTIME mode
 * — so the actual organization, billing and session hooks run.
 *
 * The happy path proves membership, workspace access, verified email and the
 * `sso.sign_in` audit. The rejection cases pin the SAML security boundary: every
 * one must redirect to the error URL carrying an `error`, set no session cookie,
 * create no session row and (for a brand-new identity) no user row, and grant no
 * membership.
 */

let harness: SsoTestHarness;
let fixture: SamlIdpFixture;
let ownerA: SsoTestUser;
let orgA: string;

// Resolved from the live SP metadata so Destination / Recipient / Audience match
// exactly what the plugin expects for this base URL.
let acmeAcsUrl: string;
let acmeAudience: string;
let otherAcsUrl: string;

const ACME_PROVIDER = "acme-saml";
const OTHER_PROVIDER = "other-saml";
const ROLE_PROVIDER = "role-saml";
const ACME_SP_ENTITY = "https://sp.sourceweft.test/acme-saml";
const OTHER_SP_ENTITY = "https://sp.sourceweft.test/other-saml";
const ROLE_SP_ENTITY = "https://sp.sourceweft.test/role-saml";
const CALLBACK_URL = "http://localhost:3000/sso-complete";

async function registerSamlProvider(input: {
  providerId: string;
  issuer: string;
  domain: string;
  organizationId: string;
  roleAttribute?: string;
}): Promise<void> {
  const response = await ownerA.client.withFreshIp().jsonRequest("/sso/register", {
    providerId: input.providerId,
    issuer: input.issuer,
    domain: input.domain,
    organizationId: input.organizationId,
    ...(input.roleAttribute ? { roleAttribute: input.roleAttribute } : {}),
    samlConfig: {
      entryPoint: fixture.entryPoint,
      idpMetadata: { metadata: fixture.metadataXml },
      mapping: { email: "email", name: "displayName" },
    },
  });
  assert.equal(response.status, 200, await response.clone().text());
}

function setCookies(response: Response): string[] {
  return (
    (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ??
    []
  );
}

function hasSessionCookie(response: Response): boolean {
  return setCookies(response).some((cookie) => {
    const match = /session_token=([^;]*)/i.exec(cookie);
    return match !== null && match[1] !== "";
  });
}

function errorParam(response: Response): string | null {
  const location = response.headers.get("location");
  if (!location) {
    return null;
  }
  return new URL(location).searchParams.get("error");
}

async function sessionUser(
  client: SsoTestClient,
): Promise<{ id: string; email: string } | null> {
  const response = await client.request("/get-session", { method: "GET" });
  if (response.status !== 200) {
    return null;
  }
  const body = (await response.json()) as {
    user?: { id: string; email: string };
  } | null;
  return body?.user ?? null;
}

async function userRow(
  email: string,
): Promise<{ id: string; emailVerified: boolean } | null> {
  const result = await harness.schema.database.query<{
    id: string;
    emailVerified: boolean;
  }>(`select id, "emailVerified" from "user" where email = $1`, [email.toLowerCase()]);
  return result.rows[0] ?? null;
}

async function memberRoleIn(
  organizationId: string,
  userId: string,
): Promise<string | null> {
  const result = await harness.schema.database.query<{ role: string }>(
    `select role from member where "organizationId" = $1 and "userId" = $2`,
    [organizationId, userId],
  );
  return result.rows[0]?.role ?? null;
}

async function memberCountIn(
  organizationId: string,
  userId: string,
): Promise<number> {
  const result = await harness.schema.database.query<{ count: number }>(
    `select count(*)::int as count from member where "organizationId" = $1 and "userId" = $2`,
    [organizationId, userId],
  );
  return result.rows[0]?.count ?? 0;
}

async function sessionCount(email: string): Promise<number> {
  const result = await harness.schema.database.query<{ count: number }>(
    `select count(*)::int as count from session s
       join "user" u on u.id = s."userId"
      where u.email = $1`,
    [email.toLowerCase()],
  );
  return result.rows[0]?.count ?? 0;
}

async function ssoAccountCount(email: string, providerId: string): Promise<number> {
  const result = await harness.schema.database.query<{ count: number }>(
    `select count(*)::int as count from account a
       join "user" u on u.id = a."userId"
      where u.email = $1 and a."providerId" = $2`,
    [email.toLowerCase(), providerId],
  );
  return result.rows[0]?.count ?? 0;
}

async function workspaceCount(
  organizationId: string,
  userId: string,
): Promise<number> {
  const { workspaceService } = await import("../workspace");
  const workspaces = await workspaceService.listWorkspaces({
    organizationId,
    userId,
  });
  return workspaces.length;
}

async function auditEntries(organizationId: string): Promise<
  Array<{
    action: string;
    actorUserId: string | null;
    targetId: string | null;
    metadata: Record<string, unknown>;
  }>
> {
  const { teamAuditService } = await import("../team-audit");
  return teamAuditService.list({ teamId: organizationId, limit: 500 });
}

/** The SP metadata XML for a provider (the public ACS/metadata endpoint). */
async function providerMetadata(providerId: string): Promise<string> {
  const response = await new SsoTestClient(harness.auth, harness.baseUrl).request(
    `/sso/saml2/sp/metadata?providerId=${encodeURIComponent(providerId)}`,
    { method: "GET" },
  );
  assert.equal(response.status, 200, await response.clone().text());
  return response.text();
}

function metadataAcsUrl(metadataXml: string): string {
  const match =
    /<AssertionConsumerService[^>]*Location="([^"]+)"/.exec(metadataXml);
  assert.ok(match, `no AssertionConsumerService Location in metadata: ${metadataXml}`);
  return match[1]!;
}

type SamlSignInStart = {
  client: SsoTestClient;
  signIn: Response;
  /** The AuthnRequest ID the IdP must answer (undefined if the start failed). */
  requestId?: string;
};

/** POST /sign-in/sso for a SAML provider and recover the AuthnRequest ID. */
async function startSamlSignIn(
  body: Record<string, unknown>,
): Promise<SamlSignInStart> {
  const client = new SsoTestClient(harness.auth, harness.baseUrl);
  const signIn = await client.jsonRequest("/sign-in/sso", {
    ...body,
    callbackURL: CALLBACK_URL,
  });
  if (signIn.status !== 200) {
    return { client, signIn };
  }
  const { url } = (await signIn.clone().json()) as { url?: string };
  assert.ok(url, `expected an IdP redirect URL, got ${await signIn.clone().text()}`);
  const samlRequest = new URL(url).searchParams.get("SAMLRequest");
  assert.ok(samlRequest, "sign-in redirect is missing SAMLRequest");
  const authnRequestXml = inflateRawSync(
    Buffer.from(decodeURIComponent(samlRequest), "base64"),
  ).toString("utf8");
  const requestId = /\bID="([^"]+)"/.exec(authnRequestXml)?.[1];
  assert.ok(requestId, `could not read the AuthnRequest ID from ${authnRequestXml}`);
  return { client, signIn, requestId };
}

/** POST a base64 SAMLResponse to a provider's ACS, as a browser form POST would. */
async function postAcs(
  client: SsoTestClient,
  providerId: string,
  samlResponse: string,
): Promise<Response> {
  return client.request(`/sso/saml2/sp/acs/${providerId}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ SAMLResponse: samlResponse }).toString(),
  });
}

/**
 * Drive a full SP-initiated acme sign-in: start, build the Response (with the
 * recovered AuthnRequest ID and the acme ACS/audience filled in) and POST it.
 */
async function acmeSignIn(
  build: (base: {
    acsUrl: string;
    audience: string;
    inResponseTo: string;
  }) => SamlResponseInput,
  signInBody: Record<string, unknown> = { email: "user@acme.com" },
): Promise<{ acs: Response; client: SsoTestClient; samlResponse: string }> {
  const start = await startSamlSignIn(signInBody);
  assert.equal(start.signIn.status, 200, await start.signIn.clone().text());
  const samlResponse = fixture.buildResponse(
    build({
      acsUrl: acmeAcsUrl,
      audience: acmeAudience,
      inResponseTo: start.requestId!,
    }),
  );
  const acs = await postAcs(start.client, ACME_PROVIDER, samlResponse);
  return { acs, client: start.client, samlResponse };
}

/** Assertions shared by every rejection case. */
async function assertRejected(
  acs: Response,
  client: SsoTestClient,
  options: { newIdentityEmail?: string } = {},
): Promise<string | null> {
  assert.equal(acs.status, 302, await acs.clone().text());
  const error = errorParam(acs);
  assert.ok(error, `expected an error redirect, got ${acs.headers.get("location")}`);
  assert.ok(!hasSessionCookie(acs), "a rejection must not set a session cookie");
  assert.equal(await sessionUser(client), null, "a rejection must not establish a session");
  if (options.newIdentityEmail) {
    assert.equal(
      await userRow(options.newIdentityEmail),
      null,
      "a rejected brand-new identity must not create a user row",
    );
    assert.equal(
      await sessionCount(options.newIdentityEmail),
      0,
      "a rejected identity must leave no session row",
    );
  }
  return error;
}

beforeAll(async () => {
  fixture = createSamlIdpFixture();
  harness = await bootSsoTestHarness("sso_saml", { mode: "runtime" });
  ownerA = await signUpUser(harness, "samlOwner");
  orgA = await createOrganization(harness, {
    ownerUserId: ownerA.userId,
    kind: "team",
    name: "Acme SAML Team",
  });

  await registerSamlProvider({
    providerId: ACME_PROVIDER,
    issuer: ACME_SP_ENTITY,
    domain: "acme.com",
    organizationId: orgA,
  });
  await setProviderDomainVerified(harness, ACME_PROVIDER);

  await registerSamlProvider({
    providerId: OTHER_PROVIDER,
    issuer: OTHER_SP_ENTITY,
    domain: "other-saml.example",
    organizationId: orgA,
  });
  await setProviderDomainVerified(harness, OTHER_PROVIDER);

  const acmeMetadata = await providerMetadata(ACME_PROVIDER);
  acmeAcsUrl = metadataAcsUrl(acmeMetadata);
  acmeAudience = ACME_SP_ENTITY;
  otherAcsUrl = metadataAcsUrl(await providerMetadata(OTHER_PROVIDER));
}, 600_000);

afterAll(async () => {
  await closeSsoTestHarness(harness);
});

test("Step 3: SP metadata ACS URL is under the configured base URL, requires signed assertions, and carries no private key", async () => {
  const metadata = await providerMetadata(ACME_PROVIDER);
  const acsUrl = metadataAcsUrl(metadata);
  assert.ok(
    acsUrl.startsWith(config.auth.baseUrl),
    `ACS URL ${acsUrl} is not under config.auth.baseUrl ${config.auth.baseUrl}`,
  );
  assert.ok(
    acsUrl.endsWith(`/sso/saml2/sp/acs/${ACME_PROVIDER}`),
    `unexpected ACS path: ${acsUrl}`,
  );
  assert.match(metadata, /WantAssertionsSigned="true"/);
  assert.ok(
    !/-----BEGIN|PrivateKey/.test(metadata),
    "SP metadata must not expose private key material",
  );
}, 200_000);

test("a valid SAML assertion with a matching InResponseTo signs the user in and joins the team", async () => {
  const email = "member@acme.com";
  const { acs, client } = await acmeSignIn(
    ({ acsUrl, audience, inResponseTo }) => ({
      acsUrl,
      audience,
      inResponseTo,
      nameId: email,
      email,
    }),
    { email },
  );
  assert.equal(acs.status, 302, await acs.clone().text());
  assert.equal(errorParam(acs), null, `unexpected error: ${acs.headers.get("location")}`);
  assert.ok(hasSessionCookie(acs), "expected a session cookie");

  const row = await userRow(email);
  assert.ok(row, "expected a user row");
  assert.equal(row.emailVerified, true, "an SSO user is created verified");
  assert.equal((await sessionUser(client))?.id, row.id);
  assert.equal(await memberRoleIn(orgA, row.id), "member");
  assert.ok((await workspaceCount(orgA, row.id)) >= 1, "expected workspace access");

  const entries = await auditEntries(orgA);
  const signIn = entries.find(
    (e) => e.action === "sso.sign_in" && e.actorUserId === row.id,
  );
  assert.ok(signIn, "expected an sso.sign_in audit entry");
  assert.deepEqual(signIn.metadata, {
    providerId: ACME_PROVIDER,
    protocol: "saml",
    domain: "acme.com",
    isNewUser: true,
  });
}, 200_000);

test("replaying the same SAML Response a second time is rejected", async () => {
  const email = "replay@acme.com";
  const { acs, samlResponse } = await acmeSignIn(
    ({ acsUrl, audience, inResponseTo }) => ({
      acsUrl,
      audience,
      inResponseTo,
      nameId: email,
      email,
    }),
    { email },
  );
  assert.equal(acs.status, 302);
  assert.equal(errorParam(acs), null, "the first sign-in succeeds");
  assert.ok(hasSessionCookie(acs));

  // Same Response, fresh client: the consumed AuthnRequest and the used-assertion
  // guard both reject it.
  const replayClient = new SsoTestClient(harness.auth, harness.baseUrl);
  const replay = await postAcs(replayClient, ACME_PROVIDER, samlResponse);
  const error = await assertRejected(replay, replayClient);
  assert.ok(error, `expected a replay rejection, got ${error}`);
}, 200_000);

test("an unsigned assertion is rejected", async () => {
  const email = "unsigned@acme.com";
  const { acs, client } = await acmeSignIn(({ acsUrl, audience, inResponseTo }) => ({
    acsUrl,
    audience,
    inResponseTo,
    nameId: email,
    email,
    sign: "none",
  }));
  await assertRejected(acs, client, { newIdentityEmail: email });
}, 200_000);

test("an IdP-initiated Response without InResponseTo is rejected", async () => {
  // allowIdpInitiated is false: a Response that answers no AuthnRequest is unsolicited.
  const email = "idpinit@acme.com";
  const start = await startSamlSignIn({ email });
  assert.equal(start.signIn.status, 200);
  const samlResponse = fixture.buildResponse({
    acsUrl: acmeAcsUrl,
    audience: acmeAudience,
    nameId: email,
    email,
    // inResponseTo omitted
  });
  const acs = await postAcs(start.client, ACME_PROVIDER, samlResponse);
  await assertRejected(acs, start.client, { newIdentityEmail: email });
}, 200_000);

test("an expired assertion (NotOnOrAfter six minutes in the past) is rejected", async () => {
  const email = "expired@acme.com";
  const sixMinutesAgo = new Date(Date.now() - 6 * 60_000);
  const { acs, client } = await acmeSignIn(({ acsUrl, audience, inResponseTo }) => ({
    acsUrl,
    audience,
    inResponseTo,
    nameId: email,
    email,
    notBefore: new Date(Date.now() - 10 * 60_000),
    notOnOrAfter: sixMinutesAgo,
  }));
  await assertRejected(acs, client, { newIdentityEmail: email });
}, 200_000);

test("an assertion with no timestamp conditions is rejected (requireTimestamps)", async () => {
  const email = "notimestamps@acme.com";
  const { acs, client } = await acmeSignIn(({ acsUrl, audience, inResponseTo }) => ({
    acsUrl,
    audience,
    inResponseTo,
    nameId: email,
    email,
    omitConditionTimestamps: true,
  }));
  await assertRejected(acs, client, { newIdentityEmail: email });
}, 200_000);

test("an assertion signed with RSA-SHA1 is rejected by the guard's algorithm policy", async () => {
  const email = "rsasha1@acme.com";
  const { acs, client } = await acmeSignIn(({ acsUrl, audience, inResponseTo }) => ({
    acsUrl,
    audience,
    inResponseTo,
    nameId: email,
    email,
    signatureAlgorithm: SAML_SIGNATURE_ALGORITHMS.rsaSha1,
  }));
  const error = await assertRejected(acs, client, { newIdentityEmail: email });
  assert.ok(
    error?.includes(SSO_ERROR_CODES.samlAlgorithmNotAllowed),
    `expected ${SSO_ERROR_CODES.samlAlgorithmNotAllowed}, got ${error}`,
  );
  assert.equal(
    await memberCountIn(orgA, (await userRow(email))?.id ?? ""),
    0,
    "a rejected sign-in grants no membership",
  );
}, 200_000);

test("an RSA-SHA256 signature with a SHA-1 digest is rejected by the guard's algorithm policy", async () => {
  const email = "sha1digest@acme.com";
  const { acs, client } = await acmeSignIn(({ acsUrl, audience, inResponseTo }) => ({
    acsUrl,
    audience,
    inResponseTo,
    nameId: email,
    email,
    // Allowed signature algorithm, but the digest is tampered to SHA-1.
    digestAlgorithmOverride: "http://www.w3.org/2000/09/xmldsig#sha1",
  }));
  const error = await assertRejected(acs, client, { newIdentityEmail: email });
  assert.ok(
    error?.includes(SSO_ERROR_CODES.samlAlgorithmNotAllowed),
    `expected ${SSO_ERROR_CODES.samlAlgorithmNotAllowed}, got ${error}`,
  );
}, 200_000);

/**
 * POST a genuinely RSA-SHA1-signed exploit (the hidden rsa-sha1 SignatureMethod
 * is the one xml-crypto would resolve and verify) straight to the ACS. The guard
 * before-hook runs the algorithm policy on the parsed document before the plugin,
 * so a real sign-in is unnecessary.
 */
async function assertExploitRejected(hide: "endTag" | "nonAscii", email: string) {
  const client = new SsoTestClient(harness.auth, harness.baseUrl);
  const exploit = fixture.buildRsaSha1Exploit({ hide, nameId: email, email });
  const acs = await postAcs(client, ACME_PROVIDER, exploit);
  const error = await assertRejected(acs, client, { newIdentityEmail: email });
  assert.ok(
    error?.includes(SSO_ERROR_CODES.samlAlgorithmNotAllowed),
    `expected ${SSO_ERROR_CODES.samlAlgorithmNotAllowed}, got ${error}`,
  );
  assert.equal(
    await memberCountIn(orgA, (await userRow(email))?.id ?? ""),
    0,
    "a rejected bypass grants no membership",
  );
}

test("the end-tag rsa-sha1 bypass (genuine signature) is rejected by the guard at the ACS (fix round 2)", async () => {
  // rsa-sha1 SignatureMethod hidden in a malformed end tag before the rsa-sha256
  // decoy; without the guard, xml-crypto recovers it and verifies RSA-SHA1.
  await assertExploitRejected("endTag", "endtag-bypass@acme.com");
}, 200_000);

test("the non-ASCII-prefix rsa-sha1 bypass (genuine signature) is rejected by the guard at the ACS (fix round 2)", async () => {
  // rsa-sha1 SignatureMethod under a non-ASCII namespace prefix, first in document
  // order; without the guard, xml-crypto resolves it by local name and verifies RSA-SHA1.
  await assertExploitRejected("nonAscii", "nonascii-bypass@acme.com");
}, 200_000);

test("a Response delivered to a different provider's ACS is rejected", async () => {
  // A fully valid acme Response (its Recipient/Destination/Audience name acme's
  // SP), POSTed to the other provider's ACS endpoint.
  const email = "wrongacs@acme.com";
  const start = await startSamlSignIn({ email });
  assert.equal(start.signIn.status, 200);
  const samlResponse = fixture.buildResponse({
    acsUrl: acmeAcsUrl,
    audience: acmeAudience,
    inResponseTo: start.requestId!,
    nameId: email,
    email,
  });
  const acs = await postAcs(start.client, OTHER_PROVIDER, samlResponse);
  await assertRejected(acs, start.client, { newIdentityEmail: email });
}, 200_000);

test("an assertion signed by a key other than the registered certificate is rejected", async () => {
  const email = "wrongkey@acme.com";
  const { acs, client } = await acmeSignIn(({ acsUrl, audience, inResponseTo }) => ({
    acsUrl,
    audience,
    inResponseTo,
    nameId: email,
    email,
    signWith: "rogue",
  }));
  await assertRejected(acs, client, { newIdentityEmail: email });
}, 200_000);

test("an assertion whose Audience is not this SP is rejected", async () => {
  const email = "wrongaudience@acme.com";
  const { acs, client } = await acmeSignIn(({ acsUrl, inResponseTo }) => ({
    acsUrl,
    audience: "https://sp.sourceweft.test/someone-else",
    inResponseTo,
    nameId: email,
    email,
  }));
  await assertRejected(acs, client, { newIdentityEmail: email });
}, 200_000);

test("an assertion whose bearer Recipient points at a different ACS is rejected", async () => {
  const email = "wrongrecipient@acme.com";
  const { acs, client } = await acmeSignIn(({ acsUrl, audience, inResponseTo }) => ({
    acsUrl,
    audience,
    inResponseTo,
    nameId: email,
    email,
    recipient: otherAcsUrl,
    destination: otherAcsUrl,
  }));
  await assertRejected(acs, client, { newIdentityEmail: email });
}, 200_000);

test("a signed Response wrapping an unsigned assertion is rejected (the assertion itself must be signed)", async () => {
  // wantAssertionsSigned: only a signature over the Assertion is accepted; a
  // message-level signature over an unsigned Assertion must not authenticate.
  const email = "messagesigned@acme.com";
  const { acs, client } = await acmeSignIn(({ acsUrl, audience, inResponseTo }) => ({
    acsUrl,
    audience,
    inResponseTo,
    nameId: email,
    email,
    sign: "message",
  }));
  await assertRejected(acs, client, { newIdentityEmail: email });
}, 200_000);

test("a second injected unsigned assertion does not authenticate the injected identity (signature wrapping)", async () => {
  const realEmail = "wrap-real@acme.com";
  const injectedEmail = "wrap-attacker@acme.com";
  const { acs, client } = await acmeSignIn(({ acsUrl, audience, inResponseTo }) => ({
    acsUrl,
    audience,
    inResponseTo,
    nameId: realEmail,
    email: realEmail,
    injectedAssertion: { nameId: injectedEmail, email: injectedEmail },
  }));
  await assertRejected(acs, client);
  assert.equal(
    await userRow(injectedEmail),
    null,
    "the injected identity must never be authenticated",
  );
  assert.equal(await userRow(realEmail), null, "the wrapped Response is rejected wholesale");
}, 200_000);

test("an identity whose email domain is unrelated to the provider is rejected", async () => {
  const victim = await signUpUser(harness, "samlvictim", {
    email: "victim@other.example",
  });
  // Attacker drives the acme provider but the IdP asserts an off-domain email.
  const { acs, client } = await acmeSignIn(
    ({ acsUrl, audience, inResponseTo }) => ({
      acsUrl,
      audience,
      inResponseTo,
      nameId: "victim@other.example",
      email: "victim@other.example",
    }),
    { providerId: ACME_PROVIDER },
  );
  const error = await assertRejected(acs, client);
  assert.ok(
    error?.includes(SSO_ERROR_CODES.accountLinkDenied),
    `expected ${SSO_ERROR_CODES.accountLinkDenied}, got ${error}`,
  );
  assert.equal(
    await memberCountIn(orgA, victim.userId),
    0,
    "the victim must not be joined to the team",
  );
  assert.equal(await ssoAccountCount("victim@other.example", ACME_PROVIDER), 0);
}, 200_000);

test("an existing verified password user on the verified domain is linked and joins the team", async () => {
  const existing = await signUpUser(harness, "samlold", {
    email: "old@acme.com",
    verified: true,
  });
  assert.equal(await memberCountIn(orgA, existing.userId), 0, "not a member before SSO");

  const { acs, client } = await acmeSignIn(({ acsUrl, audience, inResponseTo }) => ({
    acsUrl,
    audience,
    inResponseTo,
    nameId: "old@acme.com",
    email: "old@acme.com",
  }));
  assert.equal(acs.status, 302, await acs.clone().text());
  assert.equal(errorParam(acs), null);
  assert.equal((await sessionUser(client))?.id, existing.userId, "linked to the same user id");
  assert.equal(await memberRoleIn(orgA, existing.userId), "member");
  assert.equal(await ssoAccountCount("old@acme.com", ACME_PROVIDER), 1);
}, 200_000);

test("an existing UNVERIFIED password user is never linked (C1 pre-hijack takeover)", async () => {
  const attacker = await signUpUser(harness, "samlunverified", {
    email: "unverified@acme.com",
  });
  const before = await userRow("unverified@acme.com");
  assert.equal(before?.emailVerified, false, "the fixture is unverified");

  const { acs, client } = await acmeSignIn(
    ({ acsUrl, audience, inResponseTo }) => ({
      acsUrl,
      audience,
      inResponseTo,
      nameId: "unverified@acme.com",
      email: "unverified@acme.com",
    }),
    { email: "unverified@acme.com" },
  );
  const error = await assertRejected(acs, client);
  assert.ok(
    error?.includes(SSO_ERROR_CODES.accountLinkDenied),
    `expected ${SSO_ERROR_CODES.accountLinkDenied}, got ${error}`,
  );
  assert.equal(
    await ssoAccountCount("unverified@acme.com", ACME_PROVIDER),
    0,
    "no SSO account may attach to the unverified row",
  );
  assert.equal(await memberCountIn(orgA, attacker.userId), 0, "must not join the team");
  const after = await userRow("unverified@acme.com");
  assert.equal(after?.id, attacker.userId, "the same user row, not a new one");
  assert.equal(after?.emailVerified, false, "still unverified");
}, 200_000);

test("a subdomain email signs in through the parent-domain provider", async () => {
  const email = "sub@mail.acme.com";
  // Resolve by email domain: mail.acme.com falls back to the acme.com provider.
  const { acs, client } = await acmeSignIn(
    ({ acsUrl, audience, inResponseTo }) => ({
      acsUrl,
      audience,
      inResponseTo,
      nameId: email,
      email,
    }),
    { email },
  );
  assert.equal(acs.status, 302, await acs.clone().text());
  assert.equal(errorParam(acs), null, `unexpected error: ${acs.headers.get("location")}`);
  const row = await userRow(email);
  assert.ok(row, "expected the subdomain user to be created");
  assert.equal((await sessionUser(client))?.id, row.id);
  assert.equal(await memberRoleIn(orgA, row.id), "member");
}, 200_000);

test("a SAML group attribute maps an admin role through a role-managed provider", async () => {
  // A provider registered with roleAttribute (the guard injects the mapping, no
  // explicit mapping.extraFields given) in its own team org.
  const roleOrg = await createOrganization(harness, {
    ownerUserId: ownerA.userId,
    kind: "team",
    name: "Role SAML Team",
  });
  await registerSamlProvider({
    providerId: ROLE_PROVIDER,
    issuer: ROLE_SP_ENTITY,
    domain: "rolemap.example",
    organizationId: roleOrg,
    roleAttribute: "groups",
  });
  // adminRoleValue is not a register body field; set it directly like the OIDC suite.
  await setProviderRoleMapping(harness, ROLE_PROVIDER, {
    roleAttribute: "groups",
    adminRoleValue: "sw-admins",
  });
  await setProviderDomainVerified(harness, ROLE_PROVIDER);

  const roleMetadata = await providerMetadata(ROLE_PROVIDER);
  const roleAcsUrl = metadataAcsUrl(roleMetadata);

  const email = "admin@rolemap.example";
  const start = await startSamlSignIn({ email });
  assert.equal(start.signIn.status, 200, await start.signIn.clone().text());
  const samlResponse = fixture.buildResponse({
    acsUrl: roleAcsUrl,
    audience: ROLE_SP_ENTITY,
    inResponseTo: start.requestId!,
    nameId: email,
    email,
    attributes: { groups: ["sw-admins"] },
  });
  const acs = await postAcs(start.client, ROLE_PROVIDER, samlResponse);
  assert.equal(acs.status, 302, await acs.clone().text());
  assert.equal(errorParam(acs), null, `unexpected error: ${acs.headers.get("location")}`);

  const row = await userRow(email);
  assert.ok(row, "expected the admin user to be created");
  assert.equal(await memberRoleIn(roleOrg, row.id), "admin");
}, 200_000);

// ── Providers registered with explicit fields, the way the settings UI does ──
// (sso-provider-dialog.tsx buildBody(): samlConfig = { entryPoint, cert,
// idpMetadata: { entityID }, wantAssertionsSigned: true }, cert as bare base64,
// top-level issuer = SP entity id — never idpMetadata.metadata XML.)

/** Register a provider exactly as the UI's buildBody() would for SAML. */
async function registerSamlProviderExplicit(input: {
  providerId: string;
  issuer: string;
  domain: string;
  organizationId: string;
  cert: string;
}): Promise<void> {
  const response = await ownerA.client.withFreshIp().jsonRequest("/sso/register", {
    providerId: input.providerId,
    domain: input.domain,
    organizationId: input.organizationId,
    issuer: input.issuer,
    samlConfig: {
      entryPoint: fixture.entryPoint,
      cert: input.cert,
      idpMetadata: { entityID: fixture.entityId },
      wantAssertionsSigned: true,
    },
  });
  assert.equal(response.status, 200, await response.clone().text());
}

/** SP-initiate, build a correctly (or rogue-) signed response, POST to the ACS. */
async function explicitSignIn(input: {
  providerId: string;
  issuer: string;
  email: string;
  signWith?: "idp" | "rogue";
}): Promise<{ acs: Response; client: SsoTestClient }> {
  const acsUrl = metadataAcsUrl(await providerMetadata(input.providerId));
  const start = await startSamlSignIn({ email: input.email });
  assert.equal(start.signIn.status, 200, await start.signIn.clone().text());
  const samlResponse = fixture.buildResponse({
    acsUrl,
    audience: input.issuer,
    inResponseTo: start.requestId!,
    nameId: input.email,
    email: input.email,
    ...(input.signWith ? { signWith: input.signWith } : {}),
  });
  const acs = await postAcs(start.client, input.providerId, samlResponse);
  return { acs, client: start.client };
}

async function freshExplicitProvider(input: {
  name: string;
  cert: string;
}): Promise<{ providerId: string; issuer: string; organizationId: string; domain: string }> {
  const organizationId = await createOrganization(harness, {
    ownerUserId: ownerA.userId,
    kind: "team",
    name: input.name,
  });
  const providerId = `explicit-${input.name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`;
  const domain = `${providerId}.example`;
  const issuer = `https://sp.sourceweft.test/metadata?providerId=${providerId}`;
  await registerSamlProviderExplicit({ providerId, issuer, domain, organizationId, cert: input.cert });
  await setProviderDomainVerified(harness, providerId);
  return { providerId, issuer, organizationId, domain };
}

test("a provider registered with explicit fields (bare base64 cert) verifies a signed response and joins the user", async () => {
  const p = await freshExplicitProvider({ name: "Explicit Base64", cert: fixture.certBase64 });
  const email = `user@${p.domain}`;
  const { acs, client } = await explicitSignIn({ providerId: p.providerId, issuer: p.issuer, email });
  assert.equal(acs.status, 302, await acs.clone().text());
  assert.equal(errorParam(acs), null, `unexpected error: ${acs.headers.get("location")}`);
  const row = await userRow(email);
  assert.ok(row, "expected a user row");
  assert.equal((await sessionUser(client))?.id, row.id);
  assert.equal(await memberRoleIn(p.organizationId, row.id), "member");
}, 200_000);

test("a provider registered with the certificate as PEM (with headers) also verifies a signed response", async () => {
  const p = await freshExplicitProvider({ name: "Explicit Pem", cert: fixture.cert });
  const email = `user@${p.domain}`;
  const { acs } = await explicitSignIn({ providerId: p.providerId, issuer: p.issuer, email });
  assert.equal(acs.status, 302, await acs.clone().text());
  assert.equal(errorParam(acs), null, `unexpected error: ${acs.headers.get("location")}`);
  const row = await userRow(email);
  assert.ok(row, "expected a user row");
  assert.equal(await memberRoleIn(p.organizationId, row.id), "member");
}, 200_000);

test("a response signed by a different key is rejected for an explicit-fields provider", async () => {
  const p = await freshExplicitProvider({ name: "Explicit Rogue", cert: fixture.certBase64 });
  const email = `user@${p.domain}`;
  const { acs, client } = await explicitSignIn({
    providerId: p.providerId,
    issuer: p.issuer,
    email,
    signWith: "rogue",
  });
  await assertRejected(acs, client, { newIdentityEmail: email });
}, 200_000);

test("updating only the SAML entryPoint keeps the stored certificate and entity ID working", async () => {
  const p = await freshExplicitProvider({ name: "Explicit Update Entry", cert: fixture.certBase64 });
  const update = await ownerA.client.withFreshIp().jsonRequest("/sso/update-provider", {
    providerId: p.providerId,
    samlConfig: { entryPoint: `${fixture.entryPoint}/v2` },
  });
  assert.equal(update.status, 200, await update.clone().text());

  const email = `after-update@${p.domain}`;
  const { acs, client } = await explicitSignIn({ providerId: p.providerId, issuer: p.issuer, email });
  assert.equal(acs.status, 302, await acs.clone().text());
  assert.equal(
    errorParam(acs),
    null,
    `sign-in must still succeed after the entryPoint update: ${acs.headers.get("location")}`,
  );
  assert.equal((await sessionUser(client))?.id, (await userRow(email))?.id);
}, 200_000);

test("updating only idpMetadata.entityID does not drop the stored certificate", async () => {
  const p = await freshExplicitProvider({ name: "Explicit Update Entity", cert: fixture.certBase64 });
  const update = await ownerA.client.withFreshIp().jsonRequest("/sso/update-provider", {
    providerId: p.providerId,
    samlConfig: { idpMetadata: { entityID: fixture.entityId } },
  });
  assert.equal(update.status, 200, await update.clone().text());

  const email = `after-entity-update@${p.domain}`;
  const { acs, client } = await explicitSignIn({ providerId: p.providerId, issuer: p.issuer, email });
  assert.equal(acs.status, 302, await acs.clone().text());
  assert.equal(
    errorParam(acs),
    null,
    `sign-in must still succeed after the idpMetadata update: ${acs.headers.get("location")}`,
  );
  assert.equal((await sessionUser(client))?.id, (await userRow(email))?.id);
}, 200_000);

// ── R9: the SAML certificate (a trust anchor) locks after an account links ──

test("changing the SAML certificate after a sign-in returns 409 SSO_PROVIDER_IDENTITY_LOCKED", async () => {
  const p = await freshExplicitProvider({ name: "Lock Cert", cert: fixture.certBase64 });
  const email = `user@${p.domain}`;
  const { acs } = await explicitSignIn({ providerId: p.providerId, issuer: p.issuer, email });
  assert.equal(errorParam(acs), null, "the sign-in links an account first");

  const update = await ownerA.client.withFreshIp().jsonRequest(
    "/sso/update-provider",
    { providerId: p.providerId, samlConfig: { cert: fixture.rogueCertBase64 } },
    { headers: { "x-sw-locale": "zh-CN" } },
  );
  assert.equal(update.status, 409, await update.clone().text());
  const body = (await update.clone().json()) as { code?: string; message?: string };
  assert.equal(body.code, SSO_ERROR_CODES.providerIdentityLocked);
  assert.equal(
    body.message,
    "已有成员通过该身份源登录后，这些设置不能再修改。如需修改，请删除该身份源后重新添加。",
  );
}, 200_000);

test("after a sign-in, updating only the SAML domain still succeeds", async () => {
  const p = await freshExplicitProvider({ name: "Lock Ok", cert: fixture.certBase64 });
  const { acs } = await explicitSignIn({
    providerId: p.providerId,
    issuer: p.issuer,
    email: `user@${p.domain}`,
  });
  assert.equal(errorParam(acs), null);
  const update = await ownerA.client.withFreshIp().jsonRequest("/sso/update-provider", {
    providerId: p.providerId,
    domain: `renamed-${p.providerId}.example`,
  });
  assert.equal(update.status, 200, await update.clone().text());
}, 200_000);

// ── R5: a combined SAML update keeps a stored custom mapping ─────────────────

test("a SAML combined update with samlConfig + role attribute keeps a custom mapping.email", async () => {
  const org = await createOrganization(harness, {
    ownerUserId: ownerA.userId,
    kind: "team",
    name: "R5 SAML",
  });
  const providerId = `r5-saml-${randomUUID().slice(0, 8)}`;
  const register = await ownerA.client.withFreshIp().jsonRequest("/sso/register", {
    providerId,
    issuer: `https://sp.sourceweft.test/${providerId}`,
    domain: `${providerId}.example`,
    organizationId: org,
    samlConfig: {
      entryPoint: fixture.entryPoint,
      idpMetadata: { metadata: fixture.metadataXml },
      mapping: { email: "mail", name: "displayName" },
    },
  });
  assert.equal(register.status, 200, await register.clone().text());

  // Combined update: a samlConfig change WITHOUT a mapping, plus a role
  // attribute. The custom email mapping must survive.
  const update = await ownerA.client.withFreshIp().jsonRequest("/sso/update-provider", {
    providerId,
    samlConfig: { entryPoint: `${fixture.entryPoint}/v2` },
    roleAttribute: "groups",
  });
  assert.equal(update.status, 200, await update.clone().text());

  const stored = await readStoredProvider(harness, providerId);
  const saml = JSON.parse(stored.samlConfig ?? "{}") as {
    mapping?: { email?: string; extraFields?: Record<string, unknown> };
  };
  assert.equal(saml.mapping?.email, "mail", "the custom email mapping is preserved");
  assert.equal(saml.mapping?.extraFields?.groups, "groups", "the role claim is carried");
}, 200_000);
