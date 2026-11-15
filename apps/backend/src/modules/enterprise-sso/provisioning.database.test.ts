import assert from "node:assert/strict";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { billingOrganizationHooks } from "../../billing-host/bindings";
import {
  startMockOidcServer,
  type MockOidcClaims,
  type MockOidcServer,
} from "../../test/mock-oidc-server";
import { SSO_ERROR_CODES } from "./errors";
import {
  addOrganizationMember,
  bootSsoTestHarness,
  closeSsoTestHarness,
  createOrganization,
  setProviderDomainVerified,
  setProviderRoleMapping,
  signUpUser,
  SsoTestClient,
  type SsoTestHarness,
  type SsoTestUser,
} from "./sso-test-helpers";

/**
 * End-to-end proof of SSO just-in-time provisioning against the real
 * `@better-auth/sso` OIDC flow, a mock IdP (see ../../test/mock-oidc-server.ts)
 * and a migrated database booted in RUNTIME mode — so the actual organization
 * and session hooks run: billing seat checks, shared-workspace provisioning,
 * personal-org creation and the team audit log.
 *
 * The two security-critical invariants (plan Review Focus 1 and 2):
 *  - an identity whose email domain is not covered by the provider's verified
 *    domain can never link to or create an account, nor gain membership;
 *  - a billing seat rejection leaves no session, no session row and no new
 *    account/user behind, and redirects to the error page with SSO_SEAT_LIMIT.
 */

let harness: SsoTestHarness;
let mock: MockOidcServer;
let ownerA: SsoTestUser;
let orgA: string;
let acmeProviderId: string; // acme.com, role-managed
let betaProviderId: string; // beta.com, no role mapping
let unverifiedProviderId: string; // registered but never verified

const CALLBACK_URL = "http://localhost:3000/sso-complete";

async function registerOidcProvider(input: { domain: string }): Promise<string> {
  const providerId = `prov-oidc-${input.domain}-${Date.now()}`;
  const response = await ownerA.client.jsonRequest("/sso/register", {
    providerId,
    issuer: mock.issuer,
    domain: input.domain,
    organizationId: orgA,
    oidcConfig: {
      clientId: mock.clientId,
      clientSecret: mock.clientSecret,
      tokenEndpointAuthentication: "client_secret_basic",
      skipDiscovery: true,
      pkce: false,
      scopes: ["openid", "email", "profile"],
      authorizationEndpoint: `${mock.issuer}/authorize`,
      tokenEndpoint: `${mock.issuer}/token`,
      jwksEndpoint: `${mock.issuer}/jwks`,
      userInfoEndpoint: `${mock.issuer}/userinfo`,
      mapping: { email: "email", name: "name", extraFields: { groups: "groups" } },
    },
  });
  assert.equal(response.status, 200, await response.clone().text());
  return providerId;
}

function setCookies(response: Response): string[] {
  return (
    (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ??
    []
  );
}

/** Whether a response sets a non-empty session cookie. */
function hasSessionCookie(response: Response): boolean {
  return setCookies(response).some((cookie) => {
    const match = /session_token=([^;]*)/i.exec(cookie);
    return match !== null && match[1] !== "";
  });
}

type SignInResult = {
  signIn: Response;
  callback?: Response;
  client: SsoTestClient;
};

/**
 * Drive one full OIDC sign-in: POST /sign-in/sso, follow the authorize redirect
 * to the mock IdP over real HTTP, then replay its callback through the auth
 * handler on the same client (so the state cookie matches).
 */
async function signInViaSso(input: {
  claims: MockOidcClaims;
  body: Record<string, unknown>;
}): Promise<SignInResult> {
  mock.setClaims(input.claims);
  const client = new SsoTestClient(harness.auth, harness.baseUrl);
  const signIn = await client.jsonRequest("/sign-in/sso", {
    ...input.body,
    callbackURL: CALLBACK_URL,
  });
  if (signIn.status !== 200) {
    return { signIn, client };
  }
  const { url } = (await signIn.clone().json()) as { url?: string };
  assert.ok(url, `expected an authorization URL, got ${await signIn.clone().text()}`);

  const authorize = await fetch(url, { redirect: "manual" });
  const location = authorize.headers.get("location");
  assert.ok(location, `mock IdP did not redirect (status ${authorize.status})`);

  const callbackUrl = new URL(location);
  const callbackPath = `${callbackUrl.pathname.replace(/^\/api\/auth/, "")}${callbackUrl.search}`;
  const callback = await client.request(callbackPath, { method: "GET" });
  return { signIn, callback, client };
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
  }>(`select id, "emailVerified" from "user" where email = $1`, [
    email.toLowerCase(),
  ]);
  return result.rows[0] ?? null;
}

async function memberRole(userId: string): Promise<string | null> {
  const result = await harness.schema.database.query<{ role: string }>(
    `select role from member where "organizationId" = $1 and "userId" = $2`,
    [orgA, userId],
  );
  return result.rows[0]?.role ?? null;
}

async function memberCount(userId: string): Promise<number> {
  const result = await harness.schema.database.query<{ count: number }>(
    `select count(*)::int as count from member where "organizationId" = $1 and "userId" = $2`,
    [orgA, userId],
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

async function personalOrgCount(userId: string): Promise<number> {
  const result = await harness.schema.database.query<{ count: number }>(
    `select count(*)::int as count from member m
       join organization o on o.id = m."organizationId"
      where m."userId" = $1
        and o.metadata::jsonb #>> '{sourceweft,kind}' = 'personal'`,
    [userId],
  );
  return result.rows[0]?.count ?? 0;
}

async function workspaceCount(userId: string): Promise<number> {
  const { workspaceService } = await import("../workspace");
  const workspaces = await workspaceService.listWorkspaces({
    organizationId: orgA,
    userId,
  });
  return workspaces.length;
}

async function auditEntries(): Promise<
  Array<{
    action: string;
    actorUserId: string | null;
    targetId: string | null;
    metadata: Record<string, unknown>;
  }>
> {
  const { teamAuditService } = await import("../team-audit");
  return teamAuditService.list({ teamId: orgA, limit: 500 });
}

beforeAll(async () => {
  mock = await startMockOidcServer();
  harness = await bootSsoTestHarness("sso_prov", {
    mode: "runtime",
    trustedOrigins: [mock.issuer],
  });
  ownerA = await signUpUser(harness, "provOwner");
  orgA = await createOrganization(harness, {
    ownerUserId: ownerA.userId,
    kind: "team",
    name: "Acme Team",
  });

  // All providers share the mock's client id: the mock signs the id_token with
  // that audience, so a differing client id would fail the audience check. The
  // sign-in provider is still selected by domain, not by client id.
  acmeProviderId = await registerOidcProvider({ domain: "acme.com" });
  await setProviderDomainVerified(harness, acmeProviderId);
  await setProviderRoleMapping(harness, acmeProviderId, {
    roleAttribute: "groups",
    adminRoleValue: "sw-admins",
  });

  betaProviderId = await registerOidcProvider({ domain: "beta.com" });
  await setProviderDomainVerified(harness, betaProviderId);
  // No role mapping on the beta provider.

  unverifiedProviderId = await registerOidcProvider({
    domain: "unverified.example",
  });
  // Deliberately NOT verified.
}, 600_000);

afterAll(async () => {
  await closeSsoTestHarness(harness);
  await mock?.close();
});

test("a new user is created, verified, joined to the team and given workspace access", async () => {
  const email = "new@acme.com";
  const { callback, client } = await signInViaSso({
    claims: { sub: "sub-new", email, name: "New User", groups: [] },
    body: { email },
  });
  assert.ok(callback, "expected a callback response");
  assert.equal(callback.status, 302, await callback.clone().text());
  assert.ok(
    !new URL(callback.headers.get("location")!).searchParams.get("error"),
    `unexpected error redirect: ${callback.headers.get("location")}`,
  );
  assert.ok(hasSessionCookie(callback), "expected a session cookie");

  const row = await userRow(email);
  assert.ok(row, "expected a user row");
  assert.equal(row.emailVerified, true);

  const session = await sessionUser(client);
  assert.equal(session?.id, row.id);
  assert.equal(await memberRole(row.id), "member");
  assert.ok((await personalOrgCount(row.id)) >= 1, "expected a personal org");
  assert.ok((await workspaceCount(row.id)) >= 1, "expected shared workspace access");

  const entries = await auditEntries();
  assert.ok(
    entries.some(
      (e) => e.action === "organization.member_added" && e.targetId === row.id,
    ),
    "expected organization.member_added",
  );
  const signIn = entries.find(
    (e) => e.action === "sso.sign_in" && e.actorUserId === row.id,
  );
  assert.ok(signIn, "expected sso.sign_in");
  assert.deepEqual(signIn.metadata, {
    providerId: acmeProviderId,
    protocol: "oidc",
    domain: "acme.com",
    isNewUser: true,
  });
}, 200_000);

test("the same identity signing in again does not duplicate the user or member", async () => {
  const email = "new@acme.com";
  const before = await userRow(email);
  assert.ok(before);
  const beforeMembers = await memberCount(before.id);

  const { callback, client } = await signInViaSso({
    claims: { sub: "sub-new", email, name: "New User", groups: [] },
    body: { email },
  });
  assert.equal(callback?.status, 302, await callback?.clone().text());

  const session = await sessionUser(client);
  assert.equal(session?.id, before.id, "re-login must reuse the same user");
  assert.equal(await memberCount(before.id), beforeMembers, "no duplicate member");

  const entries = await auditEntries();
  assert.ok(
    entries.some(
      (e) =>
        e.action === "sso.sign_in" &&
        e.actorUserId === before.id &&
        e.metadata.isNewUser === false,
    ),
    "expected a sso.sign_in with isNewUser:false",
  );
}, 200_000);

test("an existing password account on a verified domain is linked, not duplicated", async () => {
  const existing = await signUpUser(harness, "old", { email: "old@acme.com" });
  assert.equal(await memberCount(existing.userId), 0, "not a member before SSO");

  const { callback, client } = await signInViaSso({
    claims: { sub: "sub-old", email: "old@acme.com", name: "Old User", groups: [] },
    body: { email: "old@acme.com" },
  });
  assert.equal(callback?.status, 302, await callback?.clone().text());

  const session = await sessionUser(client);
  assert.equal(session?.id, existing.userId, "must link to the original user id");
  assert.equal(await memberRole(existing.userId), "member");
  assert.equal(await ssoAccountCount("old@acme.com", acmeProviderId), 1);
}, 200_000);

test("an identity whose email domain is unrelated to the provider is rejected (Review Focus 1)", async () => {
  const victim = await signUpUser(harness, "victim", {
    email: "victim@other.com",
  });

  const { signIn, callback, client } = await signInViaSso({
    claims: {
      sub: "sub-attacker",
      email: "victim@other.com",
      name: "Victim",
      groups: [],
    },
    // Attacker drives the acme provider directly; the IdP returns an off-domain
    // email to try to seize the victim's existing account.
    body: { providerId: acmeProviderId },
  });
  assert.equal(signIn.status, 200, await signIn.clone().text());
  assert.ok(callback, "expected a callback");
  assert.equal(callback.status, 302);
  assert.ok(
    callback.headers.get("location")!.includes(SSO_ERROR_CODES.accountLinkDenied),
    `expected SSO_ACCOUNT_LINK_DENIED, got ${callback.headers.get("location")}`,
  );
  assert.ok(!hasSessionCookie(callback), "must not set a session cookie");
  assert.equal(await sessionUser(client), null, "must not establish a session");
  assert.equal(
    await ssoAccountCount("victim@other.com", acmeProviderId),
    0,
    "must not link an account",
  );
  assert.equal(await memberCount(victim.userId), 0, "victim must not join the team");
}, 200_000);

test("a parent-domain-verified provider trusts a subdomain email (controller ruling)", async () => {
  const email = "sub@mail.acme.com";
  const { callback, client } = await signInViaSso({
    claims: { sub: "sub-subdomain", email, name: "Sub User", groups: [] },
    body: { email },
  });
  assert.equal(callback?.status, 302, await callback?.clone().text());
  assert.ok(
    !new URL(callback!.headers.get("location")!).searchParams.get("error"),
    `unexpected error: ${callback!.headers.get("location")}`,
  );

  const row = await userRow(email);
  assert.ok(row, "expected the subdomain user to be created");
  assert.equal((await sessionUser(client))?.id, row.id);
  assert.equal(await memberRole(row.id), "member");
}, 200_000);

test("sign-in to an unverified provider is a 401", async () => {
  const response = await new SsoTestClient(harness.auth, harness.baseUrl).jsonRequest(
    "/sign-in/sso",
    { providerId: unverifiedProviderId, callbackURL: CALLBACK_URL },
  );
  assert.equal(response.status, 401, await response.clone().text());
}, 200_000);

test("a seat-limit rejection leaves no session, user or membership (Review Focus 2)", async () => {
  const email = "seat@acme.com";
  const spy = vi
    .spyOn(billingOrganizationHooks, "beforeAddMember")
    .mockRejectedValue(new Error("seat limit reached"));
  let result: SignInResult;
  try {
    result = await signInViaSso({
      claims: { sub: "sub-seat", email, name: "Seat User", groups: [] },
      body: { email },
    });
  } finally {
    spy.mockRestore();
  }

  const { callback, client } = result;
  assert.ok(callback, "expected a callback");
  assert.equal(callback.status, 302);
  assert.ok(
    callback.headers.get("location")!.includes(SSO_ERROR_CODES.seatLimit),
    `expected SSO_SEAT_LIMIT, got ${callback.headers.get("location")}`,
  );
  assert.ok(!hasSessionCookie(callback), "must not set a session cookie");
  assert.equal(await sessionUser(client), null, "must not establish a session");
  // A brand-new user rejected for seats is rolled back with the transaction:
  // no user row, so no session row and no membership.
  assert.equal(await userRow(email), null, "the new user row must be rolled back");
  assert.equal(await sessionCount(email), 0, "no session row");
}, 200_000);

test("an owner's role is never downgraded by role mapping (Review Focus 4)", async () => {
  const boss = await signUpUser(harness, "boss", { email: "boss@acme.com" });
  await addOrganizationMember(harness, {
    organizationId: orgA,
    userId: boss.userId,
    role: "owner",
  });

  const { callback } = await signInViaSso({
    // groups:[] would map to member, but owner must be left untouched.
    claims: { sub: "sub-boss", email: "boss@acme.com", name: "Boss", groups: [] },
    body: { email: "boss@acme.com" },
  });
  assert.equal(callback?.status, 302, await callback?.clone().text());
  assert.equal(await memberRole(boss.userId), "owner");
}, 200_000);

test("an existing member is promoted to admin when the admin group is asserted", async () => {
  const promote = await signUpUser(harness, "promote", {
    email: "promote@acme.com",
  });
  await addOrganizationMember(harness, {
    organizationId: orgA,
    userId: promote.userId,
    role: "member",
  });

  const { callback } = await signInViaSso({
    claims: {
      sub: "sub-promote",
      email: "promote@acme.com",
      name: "Promote",
      groups: ["sw-admins"],
    },
    body: { email: "promote@acme.com" },
  });
  assert.equal(callback?.status, 302, await callback?.clone().text());
  assert.equal(await memberRole(promote.userId), "admin");

  const entries = await auditEntries();
  assert.ok(
    entries.some(
      (e) =>
        e.action === "organization.member_role_changed" &&
        e.targetId === promote.userId,
    ),
    "expected organization.member_role_changed",
  );
}, 200_000);

test("an admin's role is unchanged when the provider has no role mapping", async () => {
  const keep = await signUpUser(harness, "keepadmin", {
    email: "keepadmin@beta.com",
  });
  await addOrganizationMember(harness, {
    organizationId: orgA,
    userId: keep.userId,
    role: "admin",
  });

  const { callback } = await signInViaSso({
    // The admin group is asserted, but the beta provider manages no roles.
    claims: {
      sub: "sub-keepadmin",
      email: "keepadmin@beta.com",
      name: "Keep Admin",
      groups: ["sw-admins"],
    },
    body: { email: "keepadmin@beta.com" },
  });
  assert.equal(callback?.status, 302, await callback?.clone().text());
  assert.equal(await memberRole(keep.userId), "admin");
}, 200_000);

test("an already-invited member is linked without a duplicate row or role change", async () => {
  const invited = await signUpUser(harness, "invited", {
    email: "invited@beta.com",
  });
  await addOrganizationMember(harness, {
    organizationId: orgA,
    userId: invited.userId,
    role: "member",
  });

  const { callback, client } = await signInViaSso({
    claims: {
      sub: "sub-invited",
      email: "invited@beta.com",
      name: "Invited",
      groups: [],
    },
    body: { email: "invited@beta.com" },
  });
  assert.equal(callback?.status, 302, await callback?.clone().text());

  assert.equal((await sessionUser(client))?.id, invited.userId);
  expect(await memberCount(invited.userId)).toBe(1);
  assert.equal(await memberRole(invited.userId), "member");
  assert.equal(await ssoAccountCount("invited@beta.com", betaProviderId), 1);
}, 200_000);

test("an IdP email without an @ is rejected cleanly, not with a 500", async () => {
  const { signIn, callback, client } = await signInViaSso({
    claims: { sub: "sub-noat", email: "notanemail", name: "No At", groups: [] },
    body: { providerId: acmeProviderId },
  });
  assert.equal(signIn.status, 200, await signIn.clone().text());
  assert.ok(callback, "expected a callback");
  assert.equal(callback.status, 302);
  assert.ok(
    callback.headers.get("location")!.includes(SSO_ERROR_CODES.accountLinkDenied),
    `expected a clean rejection, got ${callback.headers.get("location")}`,
  );
  assert.equal(await sessionUser(client), null, "must not establish a session");
  assert.equal(await userRow("notanemail"), null, "must not create a user");
}, 200_000);

test("sign-in is rejected when the provider's organization is no longer a team org", async () => {
  // A dedicated provider whose organization we demote out from under it.
  const demotedOrg = await createOrganization(harness, {
    ownerUserId: ownerA.userId,
    kind: "team",
    name: "Demoted Team",
  });
  const providerId = `prov-oidc-demoted-${Date.now()}`;
  const register = await ownerA.client.jsonRequest("/sso/register", {
    providerId,
    issuer: mock.issuer,
    domain: "demoted.example",
    organizationId: demotedOrg,
    oidcConfig: {
      clientId: mock.clientId,
      clientSecret: mock.clientSecret,
      tokenEndpointAuthentication: "client_secret_basic",
      skipDiscovery: true,
      pkce: false,
      scopes: ["openid", "email", "profile"],
      authorizationEndpoint: `${mock.issuer}/authorize`,
      tokenEndpoint: `${mock.issuer}/token`,
      jwksEndpoint: `${mock.issuer}/jwks`,
      userInfoEndpoint: `${mock.issuer}/userinfo`,
      mapping: { email: "email", name: "name" },
    },
  });
  assert.equal(register.status, 200, await register.clone().text());
  await setProviderDomainVerified(harness, providerId);

  // Demote the organization to personal directly in SQL.
  await harness.schema.database.query(
    `update organization set metadata = $2 where id = $1`,
    [demotedOrg, JSON.stringify({ sourceweft: { kind: "personal" } })],
  );

  const { callback, client } = await signInViaSso({
    claims: {
      sub: "sub-demoted",
      email: "member@demoted.example",
      name: "Member",
      groups: [],
    },
    body: { providerId },
  });
  assert.equal(callback?.status, 302, await callback?.clone().text());
  assert.ok(
    callback!.headers
      .get("location")!
      .includes(SSO_ERROR_CODES.organizationRequired),
    `expected SSO_ORGANIZATION_REQUIRED, got ${callback!.headers.get("location")}`,
  );
  assert.equal(await sessionUser(client), null, "must not establish a session");
  assert.equal(await userRow("member@demoted.example"), null, "must not create a user");
}, 200_000);
