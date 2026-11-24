import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test } from "vitest";
import { SSO_ERROR_CODES } from "./errors";
import {
  addOrganizationMember,
  bootSsoTestHarness,
  closeSsoTestHarness,
  createOrganization,
  setProviderDomainVerified,
  signUpUser,
  SsoTestClient,
  type SsoTestHarness,
  type SsoTestUser,
} from "./sso-test-helpers";

/**
 * Organization- and user-deletion lifecycle for SSO providers (R3), against the
 * real `@better-auth/sso` endpoints and the deletion hooks wired in
 * auth-config.ts, booted in RUNTIME mode so those hooks actually run:
 *
 *  - deleting a team removes its SSO providers and their linked `account` rows,
 *    freeing the domain for another team and disabling sign-in through the old
 *    provider id;
 *  - deleting the user who registered a team provider reassigns it to a surviving
 *    owner rather than letting the ON DELETE CASCADE take the team's provider
 *    down; a sole team owner is blocked from deleting at all.
 */

let harness: SsoTestHarness;
let owner: SsoTestUser;

const OIDC_ENDPOINTS = {
  // See guard-plugin.database.test.ts: IP-literal token/jwks skip the fake-IP
  // DNS re-check; no request is ever made to them in these tests.
  authorizationEndpoint: "https://idp.example.com/authorize",
  tokenEndpoint: "https://93.184.216.34/token",
  jwksEndpoint: "https://93.184.216.34/jwks",
};

function uniqueDomain() {
  return `${randomUUID().slice(0, 8)}.example`;
}

async function registerOidc(
  client: SsoTestClient,
  input: { organizationId: string; domain: string; clientId?: string },
): Promise<string> {
  const providerId = `lc-${randomUUID()}`.slice(0, 47);
  const response = await client.withFreshIp().jsonRequest("/sso/register", {
    providerId,
    issuer: "https://idp.example.com",
    organizationId: input.organizationId,
    domain: input.domain,
    oidcConfig: {
      clientId: input.clientId ?? "client-123",
      clientSecret: "s3cr3t",
      tokenEndpointAuthentication: "client_secret_basic",
      skipDiscovery: true,
      scopes: ["openid", "email"],
      ...OIDC_ENDPOINTS,
    },
  });
  assert.equal(response.status, 200, await response.clone().text());
  return providerId;
}

async function providerExists(providerId: string): Promise<boolean> {
  const result = await harness.schema.database.query(
    `select 1 from "ssoProvider" where "providerId" = $1`,
    [providerId],
  );
  return result.rows.length > 0;
}

async function providerUserId(providerId: string): Promise<string | null> {
  const result = await harness.schema.database.query<{ userId: string }>(
    `select "userId" from "ssoProvider" where "providerId" = $1`,
    [providerId],
  );
  return result.rows[0]?.userId ?? null;
}

async function accountCountForProvider(providerId: string): Promise<number> {
  const result = await harness.schema.database.query<{ count: number }>(
    `select count(*)::int as count from account where "providerId" = $1`,
    [providerId],
  );
  return result.rows[0]?.count ?? 0;
}

/** Insert a synthetic linked SSO account row for a provider. */
async function linkAccount(providerId: string, userId: string): Promise<void> {
  await harness.schema.database.query(
    `insert into account (id, "accountId", "providerId", "userId", "createdAt", "updatedAt")
     values ($1, $2, $3, $4, now(), now())`,
    [randomUUID(), `acct-${randomUUID()}`, providerId, userId],
  );
}

async function signInByEmail(email: string): Promise<Response> {
  return new SsoTestClient(harness.auth, harness.baseUrl).jsonRequest("/sign-in/sso", {
    email,
    callbackURL: "https://app.example.com/after",
  });
}

async function signInByProviderId(providerId: string): Promise<Response> {
  return new SsoTestClient(harness.auth, harness.baseUrl).jsonRequest("/sign-in/sso", {
    providerId,
    callbackURL: "https://app.example.com/after",
  });
}

async function userExists(userId: string): Promise<boolean> {
  const result = await harness.schema.database.query(
    `select 1 from "user" where id = $1`,
    [userId],
  );
  return result.rows.length > 0;
}

/** Run the full self-service account deletion flow (request → token → callback). */
async function deleteOwnAccount(user: SsoTestUser): Promise<Response> {
  const requested = await user.client.jsonRequest("/delete-user", {});
  assert.equal(requested.status, 200, await requested.clone().text());
  const tokenRow = await harness.schema.database.query<{ identifier: string }>(
    `select identifier from verification
       where value = $1 and identifier like 'delete-account-%'
       order by "createdAt" desc limit 1`,
    [user.userId],
  );
  const identifier = tokenRow.rows[0]?.identifier;
  assert.ok(identifier, `expected a delete-account token for ${user.email}`);
  const token = identifier.slice("delete-account-".length);
  return user.client.request(`/delete-user/callback?token=${encodeURIComponent(token)}`, {
    method: "GET",
  });
}

beforeAll(async () => {
  harness = await bootSsoTestHarness("sso_lifecycle", { mode: "runtime" });
  owner = await signUpUser(harness, "lcOwner", { verified: true });
}, 600_000);

afterAll(async () => {
  await closeSsoTestHarness(harness);
});

test("deleting a team removes its providers and account rows, freeing the domain", async () => {
  const domain = uniqueDomain();
  const org = await createOrganization(harness, {
    ownerUserId: owner.userId,
    kind: "team",
    name: "To Delete",
  });
  const providerId = await registerOidc(owner.client, { organizationId: org, domain });
  await setProviderDomainVerified(harness, providerId);
  await linkAccount(providerId, owner.userId);
  assert.equal(await accountCountForProvider(providerId), 1, "a linked account exists");

  // Sign-in through the old provider id works before deletion.
  const before = await signInByProviderId(providerId);
  assert.equal(before.status, 200, await before.clone().text());

  // Delete the organization (runs beforeDeleteOrganization → provider cleanup).
  const del = await owner.client.jsonRequest("/organization/delete", { organizationId: org });
  assert.equal(del.status, 200, await del.clone().text());

  assert.equal(await providerExists(providerId), false, "the provider row is gone");
  assert.equal(await accountCountForProvider(providerId), 0, "the linked account rows are gone");

  // Sign-in through the old provider id now fails.
  const afterDelete = await signInByProviderId(providerId);
  assert.equal(afterDelete.status, 404, await afterDelete.clone().text());

  // Another team can now register AND verify the same domain.
  const otherOrg = await createOrganization(harness, {
    ownerUserId: owner.userId,
    kind: "team",
    name: "Reuses Domain",
  });
  const reused = await registerOidc(owner.client, { organizationId: otherOrg, domain });
  await setProviderDomainVerified(harness, reused);
  const reuseSignIn = await signInByEmail(`user@${domain}`);
  assert.equal(reuseSignIn.status, 200, await reuseSignIn.clone().text());
}, 300_000);

test("deleting the user who registered a team provider reassigns it to a surviving owner", async () => {
  const domain = uniqueDomain();
  const departing = await signUpUser(harness, "lcDeparting", { verified: true });
  const successor = await signUpUser(harness, "lcSuccessor", { verified: true });
  const org = await createOrganization(harness, {
    ownerUserId: departing.userId,
    kind: "team",
    name: "Reassign Team",
  });
  await addOrganizationMember(harness, {
    organizationId: org,
    userId: successor.userId,
    role: "owner",
  });
  const providerId = await registerOidc(departing.client, { organizationId: org, domain });
  await setProviderDomainVerified(harness, providerId);
  assert.equal(await providerUserId(providerId), departing.userId, "registered by the departing user");

  const deleted = await deleteOwnAccount(departing);
  assert.equal(deleted.status, 200, await deleted.clone().text());
  assert.equal(await userExists(departing.userId), false, "the departing user is deleted");

  // The provider survives, reassigned to the surviving owner, and still works.
  assert.equal(await providerExists(providerId), true, "the provider survives the user deletion");
  assert.equal(await providerUserId(providerId), successor.userId, "reassigned to the surviving owner");
  const signIn = await signInByEmail(`user@${domain}`);
  assert.equal(signIn.status, 200, await signIn.clone().text());
}, 300_000);

test("a sole team owner is blocked from deleting their account, and the provider survives", async () => {
  const domain = uniqueDomain();
  const sole = await signUpUser(harness, "lcSole", { verified: true });
  const org = await createOrganization(harness, {
    ownerUserId: sole.userId,
    kind: "team",
    name: "Sole Owner Team",
  });
  const providerId = await registerOidc(sole.client, { organizationId: org, domain });
  await setProviderDomainVerified(harness, providerId);

  const blocked = await deleteOwnAccount(sole);
  assert.ok(blocked.status >= 400, `expected the deletion to be blocked, got ${blocked.status}`);
  assert.equal(await userExists(sole.userId), true, "the sole owner is not deleted");
  assert.equal(await providerExists(providerId), true, "the provider survives");
  assert.equal(await providerUserId(providerId), sole.userId, "still owned by the sole owner");
  // The provider still works.
  const signIn = await signInByEmail(`user@${domain}`);
  assert.equal(signIn.status, 200, await signIn.clone().text());
}, 300_000);

// Keeps SSO_ERROR_CODES imported meaningfully for a sign-in-fails assertion.
test("sign-in through a deleted team's provider id is a provider-not-found error", async () => {
  const domain = uniqueDomain();
  const org = await createOrganization(harness, {
    ownerUserId: owner.userId,
    kind: "team",
    name: "Deleted Provider Code",
  });
  const providerId = await registerOidc(owner.client, { organizationId: org, domain });
  await setProviderDomainVerified(harness, providerId);
  const del = await owner.client.jsonRequest("/organization/delete", { organizationId: org });
  assert.equal(del.status, 200, await del.clone().text());

  const signIn = await signInByProviderId(providerId);
  assert.equal(signIn.status, 404, await signIn.clone().text());
  const body = (await signIn.clone().json()) as { code?: string };
  assert.equal(body.code, SSO_ERROR_CODES.providerNotFound);
}, 300_000);
