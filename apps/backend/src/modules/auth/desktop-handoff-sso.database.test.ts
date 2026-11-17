import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vitest";
import {
  startMockOidcServer,
  type MockOidcClaims,
  type MockOidcServer,
} from "../../test/mock-oidc-server";
import {
  bootSsoTestHarness,
  closeSsoTestHarness,
  createOrganization,
  setProviderDomainVerified,
  signUpUser,
  SsoTestClient,
  type SsoTestHarness,
  type SsoTestUser,
} from "../enterprise-sso/sso-test-helpers";

/**
 * The desktop sign-in hand-off over a session that SSO created.
 *
 * The desktop app signs in through the browser and finishes by redeeming a
 * one-time token from its deep link (auth-config.ts: the `oneTimeToken` plugin,
 * whose `/one-time-token/verify` endpoint is `DESKTOP_HANDOFF_VERIFY_PATH`).
 * This proves that hand-off works unchanged when the browser session was
 * established by `@better-auth/sso` just-in-time provisioning rather than by a
 * password or social sign-in: the OIDC flow runs end to end against the mock
 * IdP exactly as the provisioning suite drives it, then the resulting session
 * generates a token and the (cookie-less) desktop client redeems it for a
 * session belonging to the same user.
 */

let harness: SsoTestHarness;
let mock: MockOidcServer;
let owner: SsoTestUser;
let orgId: string;
let providerId: string;

const CALLBACK_URL = "http://localhost:3000/sso-complete";

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

async function registerOidcProvider(domain: string): Promise<string> {
  // Provider ids must match ^[a-z0-9-]{3,47}$ (the DNS TXT label budget), so the
  // domain's dots are flattened to hyphens.
  const id = `prov-oidc-${domain.replace(/[^a-z0-9]+/g, "-")}-${Date.now().toString(36)}`;
  const response = await owner.client.jsonRequest("/sso/register", {
    providerId: id,
    issuer: mock.issuer,
    domain,
    organizationId: orgId,
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
  assert.equal(response.status, 200, await response.clone().text());
  return id;
}

/**
 * Drive one full OIDC sign-in and return the cookie-jar client that now holds
 * the SSO session (mirrors the provisioning suite's helper).
 */
async function signInViaSso(claims: MockOidcClaims): Promise<SsoTestClient> {
  mock.setClaims(claims);
  const client = new SsoTestClient(harness.auth, harness.baseUrl);
  const signIn = await client.jsonRequest("/sign-in/sso", {
    email: claims.email,
    callbackURL: CALLBACK_URL,
  });
  assert.equal(signIn.status, 200, await signIn.clone().text());
  const { url } = (await signIn.clone().json()) as { url?: string };
  assert.ok(url, `expected an authorization URL, got ${await signIn.clone().text()}`);

  const authorize = await fetch(url, { redirect: "manual" });
  const location = authorize.headers.get("location");
  assert.ok(location, `mock IdP did not redirect (status ${authorize.status})`);

  const callbackUrl = new URL(location);
  const callbackPath = `${callbackUrl.pathname.replace(/^\/api\/auth/, "")}${callbackUrl.search}`;
  const callback = await client.request(callbackPath, { method: "GET" });
  assert.equal(callback.status, 302, await callback.clone().text());
  assert.ok(
    !new URL(callback.headers.get("location")!).searchParams.get("error"),
    `unexpected error redirect: ${callback.headers.get("location")}`,
  );
  assert.ok(hasSessionCookie(callback), "SSO sign-in must set a session cookie");
  return client;
}

beforeAll(async () => {
  mock = await startMockOidcServer();
  harness = await bootSsoTestHarness("sso_handoff", {
    mode: "runtime",
    trustedOrigins: [mock.issuer],
  });
  owner = await signUpUser(harness, "handoffOwner");
  orgId = await createOrganization(harness, {
    ownerUserId: owner.userId,
    kind: "team",
    name: "Handoff Team",
  });
  providerId = await registerOidcProvider("handoff.example");
  await setProviderDomainVerified(harness, providerId);
}, 600_000);

afterAll(async () => {
  await closeSsoTestHarness(harness);
  await mock?.close();
});

test("a desktop one-time token minted from an SSO session verifies to the same user", async () => {
  const email = "member@handoff.example";
  const browser = await signInViaSso({
    sub: "sub-handoff",
    email,
    name: "Handoff Member",
  });

  // The signed-in browser session is the SSO user.
  const signedIn = await sessionUser(browser);
  assert.ok(signedIn, "expected an SSO browser session");
  assert.equal(signedIn.email, email);

  // The browser mints the one-time token the desktop deep link carries.
  const generate = await browser.request("/one-time-token/generate", {
    method: "GET",
  });
  assert.equal(generate.status, 200, await generate.clone().text());
  const { token } = (await generate.json()) as { token?: string };
  assert.ok(token, "expected a one-time token");

  // The desktop app redeems the token with no prior cookies of its own, and
  // lands a session for the same user — the `DESKTOP_HANDOFF_VERIFY_PATH` call.
  const desktop = new SsoTestClient(harness.auth, harness.baseUrl);
  const verify = await desktop.request("/one-time-token/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(verify.status, 200, await verify.clone().text());
  const envelope = (await verify.clone().json()) as {
    user?: { id: string; email: string };
  };
  assert.equal(envelope.user?.id, signedIn.id, "the handoff session is the SSO user");
  assert.ok(hasSessionCookie(verify), "the verify endpoint sets the desktop session cookie");

  // The desktop client now carries that session.
  const desktopSession = await sessionUser(desktop);
  assert.equal(desktopSession?.id, signedIn.id, "the desktop session is the SSO user");
  assert.equal(desktopSession?.email, email);
}, 200_000);

test("a desktop one-time token is single-use", async () => {
  const browser = await signInViaSso({
    sub: "sub-handoff-reuse",
    email: "reuse@handoff.example",
    name: "Reuse Member",
  });
  const generate = await browser.request("/one-time-token/generate", {
    method: "GET",
  });
  assert.equal(generate.status, 200, await generate.clone().text());
  const { token } = (await generate.json()) as { token?: string };
  assert.ok(token);

  const first = new SsoTestClient(harness.auth, harness.baseUrl);
  const firstVerify = await first.request("/one-time-token/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(firstVerify.status, 200, await firstVerify.clone().text());

  // A second redemption of the consumed token is rejected: no second session.
  const second = new SsoTestClient(harness.auth, harness.baseUrl);
  const secondVerify = await second.request("/one-time-token/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(secondVerify.status, 400, await secondVerify.clone().text());
  assert.ok(!hasSessionCookie(secondVerify), "a spent token sets no session cookie");
  assert.equal(await sessionUser(second), null, "a spent token yields no session");
}, 200_000);
