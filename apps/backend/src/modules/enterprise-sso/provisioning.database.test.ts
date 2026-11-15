import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { BillingError } from "@sourceweft/contracts/billing-runtime";
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
  readStoredProvider,
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

/** A provider id in the allowed shape (`^[a-z0-9-]{3,47}$`), derived from a label. */
let providerIdCounter = 0;
function providerIdFor(prefix: string, label: string): string {
  providerIdCounter += 1;
  const slug = label
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return `${prefix}-${slug}-${providerIdCounter}`.slice(0, 47);
}

async function registerOidcProvider(input: { domain: string }): Promise<string> {
  const providerId = providerIdFor("prov-oidc", input.domain);
  // A fresh IP per registration keeps each out of `/sso/register`'s per-IP
  // rate-limit bucket (10/60s), which one reused admin client would exhaust.
  const response = await ownerA.client.withFreshIp().jsonRequest("/sso/register", {
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

async function userCount(): Promise<number> {
  const result = await harness.schema.database.query<{ count: number }>(
    `select count(*)::int as count from "user"`,
  );
  return result.rows[0]?.count ?? 0;
}

async function codeOf(response: Response): Promise<string | undefined> {
  const body = (await response.clone().json()) as { code?: string };
  return body.code;
}

/**
 * Spy the billing seat hook so the member-add step inside `provisionUser` fails
 * with the real seat-limit signal (`BillingError("TEAM_SEAT_LIMIT_REACHED")`),
 * which is what provisioning classifies as `SSO_SEAT_LIMIT` (anything else is a
 * generic provisioning failure).
 */
function spySeatLimit() {
  return vi
    .spyOn(billingOrganizationHooks, "beforeAddMember")
    .mockRejectedValue(
      new BillingError(
        "TEAM_SEAT_LIMIT_REACHED",
        409,
        "No team seats are available.",
      ),
    );
}

async function userCountFor(email: string): Promise<number> {
  const result = await harness.schema.database.query<{ count: number }>(
    `select count(*)::int as count from "user" where lower(email) = $1`,
    [email.toLowerCase()],
  );
  return result.rows[0]?.count ?? 0;
}

/**
 * Register an OIDC provider carrying `roleAttribute` in the body (Finding 2), in
 * a fresh team organization so the per-org provider cap (orgA is near it) is not
 * hit. Returns the organization too, for membership assertions.
 */
async function registerOidcWithRoleAttribute(input: {
  domain: string;
  roleAttribute?: string;
  adminRoleValue?: string;
}): Promise<{ response: Response; providerId: string; organizationId: string }> {
  const organizationId = await createOrganization(harness, {
    ownerUserId: ownerA.userId,
    kind: "team",
    name: `Role ${input.domain}`,
  });
  const providerId = providerIdFor("prov-role", input.domain);
  const response = await ownerA.client.withFreshIp().jsonRequest("/sso/register", {
    providerId,
    issuer: mock.issuer,
    domain: input.domain,
    organizationId,
    ...(input.roleAttribute ? { roleAttribute: input.roleAttribute } : {}),
    ...(input.adminRoleValue ? { adminRoleValue: input.adminRoleValue } : {}),
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
    },
  });
  return { response, providerId, organizationId };
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

async function storedExtraFields(
  providerId: string,
): Promise<Record<string, unknown>> {
  const stored = await readStoredProvider(harness, providerId);
  const oidc = JSON.parse(stored.oidcConfig ?? "{}") as {
    mapping?: { extraFields?: Record<string, unknown> };
  };
  return oidc.mapping?.extraFields ?? {};
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

test("an existing verified password account on a verified domain is linked, not duplicated", async () => {
  const existing = await signUpUser(harness, "old", {
    email: "old@acme.com",
    verified: true,
  });
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

test("an existing UNVERIFIED password account is never linked (C1 pre-hijack takeover)", async () => {
  // An attacker who signed up under the real person's address but never proved
  // ownership of the mailbox. SSO must not adopt that unverified row.
  const attacker = await signUpUser(harness, "unverified", {
    email: "unverified@acme.com",
  });
  const beforeRow = await userRow("unverified@acme.com");
  assert.ok(beforeRow);
  assert.equal(beforeRow.emailVerified, false, "the fixture is unverified");

  const { signIn, callback, client } = await signInViaSso({
    claims: {
      sub: "sub-unverified",
      email: "unverified@acme.com",
      name: "Unverified",
      groups: [],
    },
    body: { email: "unverified@acme.com" },
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
    await ssoAccountCount("unverified@acme.com", acmeProviderId),
    0,
    "no SSO account may attach to the unverified row",
  );
  assert.equal(
    await memberCount(attacker.userId),
    0,
    "the unverified user must not join the team",
  );
  // The pre-existing row is untouched: still unverified, credential intact.
  const afterRow = await userRow("unverified@acme.com");
  assert.equal(afterRow?.id, attacker.userId, "the same user row, not a new one");
  assert.equal(afterRow?.emailVerified, false, "still unverified");
  const credentials = await harness.schema.database.query<{ count: number }>(
    `select count(*)::int as count from account where "userId" = $1 and "providerId" = 'credential'`,
    [attacker.userId],
  );
  assert.equal(credentials.rows[0]?.count, 1, "the password credential survives");
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

test("a seat-limit rejection is non-destructive and the next sign-in retries and joins (Review Focus 2)", async () => {
  const email = "seat@acme.com";
  const spy = spySeatLimit();
  let first: SignInResult;
  try {
    first = await signInViaSso({
      claims: { sub: "sub-seat", email, name: "Seat User", groups: [] },
      body: { email },
    });
  } finally {
    spy.mockRestore();
  }

  assert.ok(first.callback, "expected a callback");
  assert.equal(first.callback.status, 302);
  assert.ok(
    first.callback.headers.get("location")!.includes(SSO_ERROR_CODES.seatLimit),
    `expected SSO_SEAT_LIMIT, got ${first.callback.headers.get("location")}`,
  );
  assert.ok(!hasSessionCookie(first.callback), "must not set a session cookie");
  assert.equal(await sessionUser(first.client), null, "must not establish a session");
  // The created session is revoked, but the brand-new identity is KEPT: the
  // user row (verified), the SSO account and its personal workspace all remain,
  // only without team membership — so the next sign-in can retry.
  assert.equal(await sessionCount(email), 0, "the created session is revoked");
  const failedRow = await userRow(email);
  assert.ok(failedRow, "the new user row is kept");
  assert.equal(failedRow.emailVerified, true, "and is verified");
  assert.equal(await ssoAccountCount(email, acmeProviderId), 1, "the SSO account is kept");
  assert.equal(await memberCount(failedRow.id), 0, "but no membership was granted");
  assert.ok((await personalOrgCount(failedRow.id)) >= 1, "its personal org survives");

  // Retry once the seat is available: joins the team, no duplicate user.
  const second = await signInViaSso({
    claims: { sub: "sub-seat", email, name: "Seat User", groups: [] },
    body: { email },
  });
  assert.equal(second.callback?.status, 302, await second.callback?.clone().text());
  assert.ok(
    !new URL(second.callback!.headers.get("location")!).searchParams.get("error"),
    `expected success on retry, got ${second.callback!.headers.get("location")}`,
  );
  assert.ok(hasSessionCookie(second.callback!), "the retry sets a session cookie");
  const joinedRow = await userRow(email);
  assert.equal(joinedRow?.id, failedRow.id, "the retry reuses the same user");
  assert.equal(await memberRole(joinedRow!.id), "member", "now a member");
  assert.equal(await userCountFor(email), 1, "exactly one user row");
}, 200_000);

test("an owner's role is never downgraded by role mapping (Review Focus 4)", async () => {
  const boss = await signUpUser(harness, "boss", {
    email: "boss@acme.com",
    verified: true,
  });
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
    verified: true,
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
    verified: true,
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
    verified: true,
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
  const providerId = providerIdFor("prov-oidc-demoted", "x");
  const register = await ownerA.client.withFreshIp().jsonRequest("/sso/register", {
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

// ── Finding 1: failure handling after the session is committed ──────────────

test("a seat-limit rejection for an existing verified user keeps their other sessions", async () => {
  const existing = await signUpUser(harness, "seatexisting", {
    email: "seatexisting@acme.com",
    verified: true,
  });
  const sessionsBefore = await sessionCount("seatexisting@acme.com");
  assert.ok(sessionsBefore >= 1, "the existing user has a sign-up session");

  const spy = spySeatLimit();
  let result: Awaited<ReturnType<typeof signInViaSso>>;
  try {
    result = await signInViaSso({
      claims: {
        sub: "sub-seatexisting",
        email: "seatexisting@acme.com",
        name: "Existing",
        groups: [],
      },
      body: { email: "seatexisting@acme.com" },
    });
  } finally {
    spy.mockRestore();
  }
  const { callback, client } = result;
  assert.equal(callback?.status, 302);
  assert.ok(
    callback!.headers.get("location")!.includes(SSO_ERROR_CODES.seatLimit),
  );
  assert.ok(!hasSessionCookie(callback!));
  assert.equal(await sessionUser(client), null);
  // Non-destructive: the existing user, its SSO account and its other sessions
  // all survive; only this sign-in's session was revoked and no seat was taken.
  assert.ok(await userRow("seatexisting@acme.com"), "existing user kept");
  assert.equal(await memberCount(existing.userId), 0, "not a member");
  assert.equal(await ssoAccountCount("seatexisting@acme.com", acmeProviderId), 1, "SSO account kept");
  assert.equal(
    await sessionCount("seatexisting@acme.com"),
    sessionsBefore,
    "their pre-existing session is intact; only the SSO session was revoked",
  );
}, 200_000);

test("a non-billing provisioning failure redirects SSO_PROVISIONING_FAILED and keeps the user", async () => {
  const { auth } = await import("../auth/auth");
  const spy = vi
    .spyOn(auth.api, "addMember")
    .mockRejectedValue(new Error("boom"));
  const email = "provfail@acme.com";
  let result: Awaited<ReturnType<typeof signInViaSso>>;
  try {
    result = await signInViaSso({
      claims: { sub: "sub-provfail", email, name: "ProvFail", groups: [] },
      body: { email },
    });
  } finally {
    spy.mockRestore();
  }
  const { callback, client } = result;
  assert.equal(callback?.status, 302);
  assert.ok(
    callback!.headers
      .get("location")!
      .includes(SSO_ERROR_CODES.provisioningFailed),
    `expected SSO_PROVISIONING_FAILED, got ${callback!.headers.get("location")}`,
  );
  assert.ok(!hasSessionCookie(callback!));
  assert.equal(await sessionUser(client), null);
  assert.equal(await sessionCount(email), 0, "the created session is revoked");
  const row = await userRow(email);
  assert.ok(row, "the user row is kept (non-destructive)");
  assert.equal(await memberCount(row.id), 0, "no membership");
}, 200_000);

test("an IdP email change plus a failed membership step leaves the existing user intact", async () => {
  // First sign-in creates the user and the SSO account under the original email.
  const first = await signInViaSso({
    claims: { sub: "sub-echange", email: "echange@acme.com", name: "E", groups: [] },
    body: { email: "echange@acme.com" },
  });
  assert.equal(first.callback?.status, 302, await first.callback?.clone().text());
  const user = await userRow("echange@acme.com");
  assert.ok(user, "the original user exists");
  // Remove them from the team so the next sign-in attempts addMember again.
  await harness.schema.database.query(
    `delete from member where "organizationId" = $1 and "userId" = $2`,
    [orgA, user.id],
  );

  // The IdP now asserts a CHANGED email for the SAME account (sub-echange), and
  // the membership step fails. isNewUser must be false (no user is created), and
  // the pre-existing user must never be deleted.
  const spy = spySeatLimit();
  let result: Awaited<ReturnType<typeof signInViaSso>>;
  try {
    result = await signInViaSso({
      claims: { sub: "sub-echange", email: "echange2@acme.com", name: "E2", groups: [] },
      body: { providerId: acmeProviderId },
    });
  } finally {
    spy.mockRestore();
  }
  assert.equal(result.callback?.status, 302);
  assert.ok(
    result.callback!.headers.get("location")!.includes(SSO_ERROR_CODES.seatLimit),
  );
  const after = await harness.schema.database.query(
    `select id from "user" where id = $1`,
    [user.id],
  );
  assert.equal(after.rows.length, 1, "the existing user row survives a failed membership step");
}, 200_000);

test("two concurrent sign-ins of the same existing identity yield exactly one member and delete nothing", async () => {
  const existing = await signUpUser(harness, "concurrent", {
    email: "concurrent@acme.com",
    verified: true,
  });
  const run = () =>
    signInViaSso({
      claims: { sub: "sub-concurrent", email: "concurrent@acme.com", name: "C", groups: [] },
      body: { email: "concurrent@acme.com" },
    });
  const [a, b] = await Promise.all([run(), run()]);
  // Both end in a redirect; the provider row lock serialises the linking, and a
  // loser's "already a member" is treated as success.
  for (const r of [a, b]) {
    assert.equal(r.callback?.status, 302, await r.callback?.clone().text());
    assert.ok(
      !new URL(r.callback!.headers.get("location")!).searchParams.get("error"),
      `expected no error redirect, got ${r.callback!.headers.get("location")}`,
    );
  }
  assert.equal(await memberCount(existing.userId), 1, "exactly one member row");
  assert.ok(await userRow("concurrent@acme.com"), "the user is not deleted");
  assert.equal(await ssoAccountCount("concurrent@acme.com", acmeProviderId), 1, "one SSO account");
}, 200_000);

test("twelve simultaneous sign-ins through one provider complete without hanging (no pool deadlock)", async () => {
  // The member-add seat hook performs a REAL query through the global pool, so
  // if the resolver still needed a second pooled connection while holding the
  // provider row lock (the I1 deadlock), twelve callbacks contending for that one
  // provider's lock would stall every pooled connection and this test would time
  // out: ten hold a connection, one holds the lock, and that lock holder could
  // never get its second connection. After the fix the resolver reads only the
  // transaction handle, so the lock holder commits and the queue drains.
  //
  // All twelve share one identity because the mock IdP serves a single identity
  // at a time; the pool-and-lock contention the deadlock needs is reproduced
  // regardless (every one of the twelve runs the resolver under the lock). The
  // spy stands in for the commercial billing seat check (which the shipped test
  // env does not enable) and is what would have deadlocked the old resolver.
  const spy = vi
    .spyOn(billingOrganizationHooks, "beforeAddMember")
    .mockImplementation(async () => {
      await harness.schema.database.query("select 1");
    });
  try {
    const runs = Array.from({ length: 12 }, () =>
      signInViaSso({
        claims: { sub: "sub-load", email: "load@acme.com", name: "Load", groups: [] },
        body: { email: "load@acme.com" },
      }),
    );
    const results = await Promise.all(runs);
    for (const [i, r] of results.entries()) {
      assert.equal(r.callback?.status, 302, `sign-in ${i}: ${await r.callback?.clone().text()}`);
      assert.ok(
        !new URL(r.callback!.headers.get("location")!).searchParams.get("error"),
        `sign-in ${i} errored: ${r.callback!.headers.get("location")}`,
      );
    }
    // The point of this test is the absence of a hang. Member-count exactness is
    // NOT asserted here: better-auth's addMember has a check-then-insert residual
    // race (acknowledged in billing-host's seat check) that twelve simultaneous
    // sign-ins of ONE shared identity can trip, which the two-concurrent test —
    // whose narrow window reliably yields one member — covers instead.
    assert.ok(await userRow("load@acme.com"), "the shared identity exists and is not deleted");
  } finally {
    spy.mockRestore();
  }
}, 120_000);

test("an audit failure after a successful add does not fail the sign-in", async () => {
  const { teamAuditService } = await import("../team-audit");
  // Fail only the sso.sign_in audit (after membership holds); leave the
  // member-added audit alone so addMember still succeeds.
  const spy = vi
    .spyOn(teamAuditService, "record")
    .mockImplementation(async (entry) => {
      if (entry.action === "sso.sign_in") {
        throw new Error("audit down");
      }
    });
  const email = "auditfail@acme.com";
  let result: Awaited<ReturnType<typeof signInViaSso>>;
  try {
    result = await signInViaSso({
      claims: { sub: "sub-auditfail", email, name: "AuditFail", groups: [] },
      body: { email },
    });
  } finally {
    spy.mockRestore();
  }
  const { callback, client } = result;
  assert.equal(callback?.status, 302);
  assert.ok(
    !new URL(callback!.headers.get("location")!).searchParams.get("error"),
    "the sign-in succeeds despite the audit failure",
  );
  assert.ok(hasSessionCookie(callback!), "a session cookie is set");
  assert.equal((await sessionUser(client))?.email, email);
  const row = await userRow(email);
  assert.ok(row);
  assert.equal(await memberRole(row.id), "member", "membership is present");
}, 200_000);

test("an IdP that returns no email claim is rejected cleanly, not with a 500", async () => {
  const before = await userCount();
  const { signIn, callback, client } = await signInViaSso({
    claims: { sub: "sub-noemail", email: "", name: "No Email", groups: [] },
    body: { providerId: acmeProviderId },
  });
  assert.equal(signIn.status, 200, await signIn.clone().text());
  assert.ok(callback);
  assert.equal(callback.status, 302);
  assert.ok(
    new URL(callback.headers.get("location")!).searchParams.get("error"),
    "a clean error redirect, not a 500",
  );
  assert.equal(await sessionUser(client), null, "no session");
  assert.equal(await userCount(), before, "no user created");
}, 200_000);

// ── Finding 2: the guard carries the role claim into the mapping ────────────

test("registering with a role attribute carries the claim into the mapping", async () => {
  const { response, providerId } = await registerOidcWithRoleAttribute({
    domain: "rolemap.example",
    roleAttribute: "groups",
    adminRoleValue: "sw-admins",
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await storedExtraFields(providerId)).groups, "groups");
}, 200_000);

test("a provider configured only with roleAttribute maps the admin group end to end", async () => {
  const { response, providerId, organizationId } =
    await registerOidcWithRoleAttribute({
      domain: "e2erole.example",
      roleAttribute: "groups",
      adminRoleValue: "sw-admins",
    });
  assert.equal(response.status, 200, await response.clone().text());
  await setProviderDomainVerified(harness, providerId);

  const user = await signUpUser(harness, "e2erole", {
    email: "e2e@e2erole.example",
    verified: true,
  });
  await addOrganizationMember(harness, {
    organizationId,
    userId: user.userId,
    role: "member",
  });

  const { callback } = await signInViaSso({
    claims: {
      sub: "sub-e2erole",
      email: "e2e@e2erole.example",
      name: "E2E Role",
      groups: ["sw-admins"],
    },
    body: { email: "e2e@e2erole.example" },
  });
  assert.equal(callback?.status, 302, await callback?.clone().text());
  assert.equal(await memberRoleIn(organizationId, user.userId), "admin");
}, 200_000);

test("updating the role attribute adds the new claim and keeps the old one", async () => {
  const { response, providerId } = await registerOidcWithRoleAttribute({
    domain: "updrole.example",
    roleAttribute: "groups",
    adminRoleValue: "sw-admins",
  });
  assert.equal(response.status, 200, await response.clone().text());

  const update = await ownerA.client.jsonRequest("/sso/update-provider", {
    providerId,
    roleAttribute: "roles",
  });
  assert.equal(update.status, 200, await update.clone().text());

  const extraFields = await storedExtraFields(providerId);
  assert.equal(extraFields.roles, "roles", "the new claim is carried");
  assert.equal(extraFields.groups, "groups", "the earlier claim is preserved");
}, 200_000);

test("a reserved role attribute is rejected with SSO_INVALID_ROLE_ATTRIBUTE", async () => {
  const { response } = await registerOidcWithRoleAttribute({
    domain: "badrole.example",
    roleAttribute: "email",
    adminRoleValue: "sw-admins",
  });
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal(await codeOf(response), SSO_ERROR_CODES.invalidRoleAttribute);
}, 200_000);

// ── Finding 3: no redundant verification mail for a domain-verified user ────

test("a new SSO user is created verified and triggers no verification email", async () => {
  const { mailService } = await import("../mail");
  const spy = vi.spyOn(mailService, "sendTemplate");
  const email = "verified@acme.com";
  try {
    const { callback } = await signInViaSso({
      claims: { sub: "sub-verified", email, name: "Verified", groups: [] },
      body: { email },
    });
    assert.equal(callback?.status, 302, await callback?.clone().text());

    const verifyCalls = spy.mock.calls.filter(([arg]) => {
      const input = arg as { templateId?: string; to?: unknown };
      const to = Array.isArray(input?.to) ? input.to : [input?.to];
      return input?.templateId === "auth.verify-email" && to.includes(email);
    });
    assert.equal(verifyCalls.length, 0, "no verification email for the SSO user");

    // A normal email/password sign-up still goes through the verification path.
    spy.mockClear();
    await signUpUser(harness, "plainverify", {
      email: `plain-${randomUUID()}@example.test`,
    });
    const signUpVerifyCalls = spy.mock.calls.filter(
      ([arg]) => (arg as { templateId?: string })?.templateId === "auth.verify-email",
    );
    assert.ok(
      signUpVerifyCalls.length >= 1,
      "a normal sign-up still sends a verification email",
    );
  } finally {
    spy.mockRestore();
  }

  const row = await userRow(email);
  assert.ok(row);
  assert.equal(row.emailVerified, true, "the SSO user is verified at creation");
}, 200_000);

// ── A fresh, isolated OIDC provider for the lifecycle / identity-lock tests ──

async function freshOidcProvider(input: {
  domain: string;
  verified?: boolean;
  roleAttribute?: string;
  mapping?: Record<string, unknown>;
}): Promise<{ providerId: string; organizationId: string }> {
  const organizationId = await createOrganization(harness, {
    ownerUserId: ownerA.userId,
    kind: "team",
    name: `Fresh ${input.domain}`,
  });
  const providerId = providerIdFor("fresh", input.domain);
  const response = await ownerA.client.withFreshIp().jsonRequest("/sso/register", {
    providerId,
    issuer: mock.issuer,
    domain: input.domain,
    organizationId,
    ...(input.roleAttribute ? { roleAttribute: input.roleAttribute } : {}),
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
      mapping: input.mapping ?? {
        email: "email",
        name: "name",
        extraFields: { groups: "groups" },
      },
    },
  });
  assert.equal(response.status, 200, await response.clone().text());
  if (input.verified) {
    await setProviderDomainVerified(harness, providerId);
  }
  return { providerId, organizationId };
}

function errorOf(response: Response): string | null {
  const location = response.headers.get("location");
  return location ? new URL(location).searchParams.get("error") : null;
}

// ── R5: a combined update keeps a stored custom mapping ─────────────────────

test("a combined update with oidcConfig scopes + role attribute keeps a custom mapping.email", async () => {
  const { providerId } = await freshOidcProvider({
    domain: "r5map.example",
    mapping: { email: "mail", name: "name" },
  });
  const update = await ownerA.client.withFreshIp().jsonRequest("/sso/update-provider", {
    providerId,
    oidcConfig: { scopes: ["openid", "email", "profile", "groups"] },
    roleAttribute: "groups",
  });
  assert.equal(update.status, 200, await update.clone().text());

  const stored = await readStoredProvider(harness, providerId);
  const oidc = JSON.parse(stored.oidcConfig ?? "{}") as {
    mapping?: { email?: string; extraFields?: Record<string, unknown> };
  };
  assert.equal(oidc.mapping?.email, "mail", "the custom email mapping is preserved");
  assert.equal(oidc.mapping?.extraFields?.groups, "groups", "the role claim is carried");
}, 200_000);

// ── R9: identity fields lock after an account is linked ─────────────────────

test("changing the OIDC issuer after a sign-in returns 409 SSO_PROVIDER_IDENTITY_LOCKED", async () => {
  const { providerId } = await freshOidcProvider({ domain: "r9issuer.example", verified: true });
  const { callback } = await signInViaSso({
    claims: { sub: "sub-r9issuer", email: "u@r9issuer.example", name: "U", groups: [] },
    body: { email: "u@r9issuer.example" },
  });
  assert.ok(callback && !errorOf(callback), `sign-in failed: ${callback?.headers.get("location")}`);

  const update = await ownerA.client.withFreshIp().jsonRequest(
    "/sso/update-provider",
    { providerId, issuer: "https://new-issuer.example.com" },
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

test("after a sign-in, changing only scopes, client secret or role attribute still succeeds", async () => {
  const { providerId } = await freshOidcProvider({ domain: "r9ok.example", verified: true });
  const { callback } = await signInViaSso({
    claims: { sub: "sub-r9ok", email: "u@r9ok.example", name: "U", groups: [] },
    body: { email: "u@r9ok.example" },
  });
  assert.ok(callback && !errorOf(callback));

  for (const patch of [
    { oidcConfig: { scopes: ["openid", "email", "profile", "offline_access"] } },
    { oidcConfig: { clientSecret: "rotated-secret" } },
    { roleAttribute: "roles" },
  ]) {
    const update = await ownerA.client.withFreshIp().jsonRequest("/sso/update-provider", {
      providerId,
      ...patch,
    });
    assert.equal(update.status, 200, `${JSON.stringify(patch)}: ${await update.clone().text()}`);
  }
}, 200_000);

// ── R10: domain change, deletion, and admin demotion ────────────────────────

test("changing a verified provider's domain makes sign-in fail until the new domain is verified", async () => {
  const { providerId } = await freshOidcProvider({ domain: "r10old.example", verified: true });
  const before = await signInViaSso({
    claims: { sub: "sub-r10a", email: "a@r10old.example", name: "A", groups: [] },
    body: { email: "a@r10old.example" },
  });
  assert.ok(before.callback && !errorOf(before.callback), "sign-in works before the domain change");

  const update = await ownerA.client.withFreshIp().jsonRequest("/sso/update-provider", {
    providerId,
    domain: "r10new.example",
  });
  assert.equal(update.status, 200, await update.clone().text());

  const failing = await new SsoTestClient(harness.auth, harness.baseUrl).jsonRequest(
    "/sign-in/sso",
    { email: "b@r10new.example", callbackURL: CALLBACK_URL },
  );
  assert.equal(failing.status, 404, await failing.clone().text());

  await setProviderDomainVerified(harness, providerId);
  const after = await signInViaSso({
    claims: { sub: "sub-r10b", email: "b@r10new.example", name: "B", groups: [] },
    body: { email: "b@r10new.example" },
  });
  assert.ok(after.callback && !errorOf(after.callback), "sign-in works after re-verification");
}, 200_000);

test("sign-in fails after the provider is deleted and its SSO account rows are gone", async () => {
  const { providerId } = await freshOidcProvider({ domain: "r10del.example", verified: true });
  const { callback } = await signInViaSso({
    claims: { sub: "sub-r10del", email: "u@r10del.example", name: "U", groups: [] },
    body: { email: "u@r10del.example" },
  });
  assert.ok(callback && !errorOf(callback));
  assert.equal(await ssoAccountCount("u@r10del.example", providerId), 1, "account linked");

  const del = await ownerA.client.withFreshIp().jsonRequest("/sso/delete-provider", {
    providerId,
  });
  assert.equal(del.status, 200, await del.clone().text());
  assert.equal(await ssoAccountCount("u@r10del.example", providerId), 0, "the SSO account rows are gone");

  const failing = await new SsoTestClient(harness.auth, harness.baseUrl).jsonRequest(
    "/sign-in/sso",
    { email: "u@r10del.example", callbackURL: CALLBACK_URL },
  );
  assert.equal(failing.status, 404, await failing.clone().text());
}, 200_000);

test("an admin is demoted when the IdP stops asserting the admin value; an owner is not", async () => {
  const { providerId, organizationId } = await freshOidcProvider({
    domain: "r10role.example",
    verified: true,
    roleAttribute: "groups",
  });
  await setProviderRoleMapping(harness, providerId, {
    roleAttribute: "groups",
    adminRoleValue: "sw-admins",
  });

  const adminUser = await signUpUser(harness, "r10admin", {
    email: "admin@r10role.example",
    verified: true,
  });
  await addOrganizationMember(harness, {
    organizationId,
    userId: adminUser.userId,
    role: "member",
  });
  await signInViaSso({
    claims: { sub: "sub-r10admin", email: "admin@r10role.example", name: "Admin", groups: ["sw-admins"] },
    body: { email: "admin@r10role.example" },
  });
  assert.equal(await memberRoleIn(organizationId, adminUser.userId), "admin", "promoted to admin");

  await signInViaSso({
    claims: { sub: "sub-r10admin", email: "admin@r10role.example", name: "Admin", groups: [] },
    body: { email: "admin@r10role.example" },
  });
  assert.equal(await memberRoleIn(organizationId, adminUser.userId), "member", "demoted to member");

  const ownerUser = await signUpUser(harness, "r10owner", {
    email: "owner@r10role.example",
    verified: true,
  });
  await addOrganizationMember(harness, {
    organizationId,
    userId: ownerUser.userId,
    role: "owner",
  });
  await signInViaSso({
    claims: { sub: "sub-r10owner", email: "owner@r10role.example", name: "Owner", groups: [] },
    body: { email: "owner@r10role.example" },
  });
  assert.equal(await memberRoleIn(organizationId, ownerUser.userId), "owner", "owner unchanged");
}, 200_000);
