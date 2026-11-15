import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

/**
 * End-to-end proof that the SSO secret-storage adapter wrapper seals the OIDC
 * clientSecret before it reaches PostgreSQL and opens it again on the way out,
 * using the real `@better-auth/sso` register/get/update endpoints and the real
 * team-secrets envelope encryption against a migrated database.
 *
 * Auth is booted in "migration" mode: it skips the runtime-only mail and
 * onboarding hooks (so sign-up and organization creation stay side-effect
 * free) while still running every plugin's `init`, which is where the adapter
 * wrapper is installed. DATABASE_URL is pointed at an isolated clone before any
 * DB-bound module is imported, so the shared connection the auth config uses
 * targets this test's own database.
 */

let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
let schema: typeof import("@sourceweft/db");
let teamSecrets: typeof import("../../shared/team-secrets");
let secretStorage: typeof import("./secret-storage");
let auth: ReturnType<
  typeof import("../auth/auth-config").createSourceweftAuth
>;
let baseUrl: string;

const PLAIN_SECRET = "s3cr3t-plain";
const jar = new Map<string, string>();

/** Minimal cookie jar: capture Set-Cookie, replay as a Cookie header. */
function captureCookies(response: Response) {
  const setCookies =
    (
      response.headers as Headers & { getSetCookie?: () => string[] }
    ).getSetCookie?.() ?? [];
  for (const setCookie of setCookies) {
    const pair = setCookie.split(";", 1)[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (value) {
      jar.set(name, value);
    } else {
      jar.delete(name);
    }
  }
}

function cookieHeader() {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (cookieHeader()) {
    headers.set("cookie", cookieHeader());
  }
  const response = await auth.handler(
    new Request(`${baseUrl}/api/auth${path}`, { ...init, headers }),
  );
  captureCookies(response);
  return response;
}

function jsonRequest(path: string, body: unknown, init: RequestInit = {}) {
  return request(path, {
    method: "POST",
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
    body: JSON.stringify(body),
  });
}

/** The endpoints a skipDiscovery OIDC registration must carry. */
function oidcEndpoints() {
  return {
    authorizationEndpoint: "https://idp.example.com/authorize",
    tokenEndpoint: "https://idp.example.com/token",
    jwksEndpoint: "https://idp.example.com/jwks",
  };
}

async function registerProvider(
  organizationId: string,
  clientSecret: string | undefined,
) {
  const providerId = `oidc-secret-${randomUUID().slice(0, 8)}`;
  const response = await jsonRequest("/sso/register", {
    providerId,
    issuer: "https://idp.example.com",
    domain: `${randomUUID().slice(0, 8)}.example.com`,
    organizationId,
    oidcConfig: {
      clientId: "client-123",
      ...(clientSecret ? { clientSecret } : {}),
      tokenEndpointAuthentication: "client_secret_basic",
      skipDiscovery: true,
      scopes: ["openid", "email"],
      ...oidcEndpoints(),
    },
  });
  assert.equal(response.status, 200, await response.clone().text());
  return providerId;
}

/** Read the raw `oidcConfig` column straight from PostgreSQL (no wrapper). */
async function rawOidcConfig(providerId: string): Promise<string> {
  const result = await schema.database.query<{ oidcConfig: string }>(
    `select "oidcConfig" from "ssoProvider" where "providerId" = $1`,
    [providerId],
  );
  const row = result.rows[0];
  assert.ok(row, `expected a stored ssoProvider row for ${providerId}`);
  return row.oidcConfig;
}

async function storedClientSecret(providerId: string): Promise<string> {
  return JSON.parse(await rawOidcConfig(providerId)).clientSecret as string;
}

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("sso_secrets");
  process.env.DATABASE_URL = isolated.url;

  schema = await import("@sourceweft/db");
  teamSecrets = await import("../../shared/team-secrets");
  secretStorage = await import("./secret-storage");
  const authConfig = await import("../auth/auth-config");
  const sharedConfig = await import("../../shared/config");
  baseUrl = sharedConfig.config.auth.baseUrl;

  auth = authConfig.createSourceweftAuth({ mode: "migration" });
  await auth.$context;

  const signUp = await jsonRequest("/sign-up/email", {
    name: "SSO Secret Test",
    email: `sso-secret-${randomUUID()}@sourceweft.test`,
    password: "correct horse battery staple",
  });
  assert.equal(signUp.status, 200, await signUp.clone().text());
}, 180_000);

afterAll(async () => {
  await schema?.database.end();
  await isolated?.close();
});

/** Create a fresh team organization owned by the signed-in user. */
async function createOrganization(): Promise<string> {
  const response = await jsonRequest("/organization/create", {
    name: "SSO Team",
    slug: `sso-team-${randomUUID().slice(0, 8)}`,
  });
  assert.equal(response.status, 200, await response.clone().text());
  const body = (await response.json()) as { id: string };
  assert.ok(body.id);
  // Migration mode skips the organization hooks that tag `kind`, so stamp the
  // team metadata the SSO guard now requires (production writes it on create).
  await schema.database.query(
    `update organization set metadata = $1 where id = $2`,
    [JSON.stringify({ sourceweft: { kind: "team" } }), body.id],
  );
  return body.id;
}

test("register seals the clientSecret at rest and it decrypts per team", async () => {
  const organizationId = await createOrganization();
  const providerId = await registerProvider(organizationId, PLAIN_SECRET);

  const stored = await rawOidcConfig(providerId);
  assert.ok(
    !stored.includes(PLAIN_SECRET),
    "the plaintext secret must never be stored",
  );
  assert.ok(
    stored.includes(secretStorage.SEALED_SECRET_PREFIX),
    "the stored secret must be sealed with the swenc: prefix",
  );

  const sealed = await storedClientSecret(providerId);
  assert.ok(sealed.startsWith(secretStorage.SEALED_SECRET_PREFIX));
  const decrypted = await teamSecrets.decryptTeamSecret(
    sealed.slice(secretStorage.SEALED_SECRET_PREFIX.length),
    organizationId,
  );
  assert.equal(decrypted, PLAIN_SECRET);
}, 60_000);

test("get and list responses expose neither the plaintext secret nor the ciphertext", async () => {
  const organizationId = await createOrganization();
  const providerId = await registerProvider(organizationId, PLAIN_SECRET);

  const get = await request(
    `/sso/get-provider?providerId=${encodeURIComponent(providerId)}`,
  );
  assert.equal(get.status, 200);
  const getText = await get.text();
  assert.ok(!getText.includes(PLAIN_SECRET), "get leaked the plaintext secret");
  assert.ok(
    !getText.includes(secretStorage.SEALED_SECRET_PREFIX),
    "get leaked the sealed ciphertext",
  );

  const list = await request("/sso/providers");
  assert.equal(list.status, 200);
  const listText = await list.text();
  assert.ok(listText.includes(providerId), "the provider should be listed");
  assert.ok(!listText.includes(PLAIN_SECRET), "list leaked the plaintext secret");
  assert.ok(
    !listText.includes(secretStorage.SEALED_SECRET_PREFIX),
    "list leaked the sealed ciphertext",
  );
}, 60_000);

test("register and update responses never include the client secret", async () => {
  const organizationId = await createOrganization();
  const providerId = `oidc-secret-${randomUUID().slice(0, 8)}`;

  const registerResponse = await jsonRequest("/sso/register", {
    providerId,
    issuer: "https://idp.example.com",
    domain: `${randomUUID().slice(0, 8)}.example.com`,
    organizationId,
    oidcConfig: {
      clientId: "client-123",
      clientSecret: PLAIN_SECRET,
      tokenEndpointAuthentication: "client_secret_basic",
      skipDiscovery: true,
      scopes: ["openid", "email"],
      ...oidcEndpoints(),
    },
  });
  assert.equal(
    registerResponse.status,
    200,
    await registerResponse.clone().text(),
  );
  const registerText = await registerResponse.clone().text();
  assert.ok(!registerText.includes(PLAIN_SECRET), "register leaked plaintext");
  assert.ok(
    !registerText.includes(secretStorage.SEALED_SECRET_PREFIX),
    "register leaked ciphertext",
  );
  const registerBody = (await registerResponse.json()) as {
    oidcConfig?: Record<string, unknown>;
  };
  assert.ok(
    registerBody.oidcConfig && !("clientSecret" in registerBody.oidcConfig),
    "register oidcConfig must have no clientSecret key",
  );

  const updateResponse = await jsonRequest("/sso/update-provider", {
    providerId,
    oidcConfig: { scopes: ["openid"] },
  });
  assert.equal(updateResponse.status, 200, await updateResponse.clone().text());
  const updateText = await updateResponse.clone().text();
  assert.ok(!updateText.includes(PLAIN_SECRET), "update leaked plaintext");
  assert.ok(
    !updateText.includes(secretStorage.SEALED_SECRET_PREFIX),
    "update leaked ciphertext",
  );
  const updateBody = (await updateResponse.json()) as {
    oidcConfig?: Record<string, unknown>;
  };
  assert.ok(
    updateBody.oidcConfig && !("clientSecret" in updateBody.oidcConfig),
    "update oidcConfig must have no clientSecret key",
  );
}, 60_000);

test("updating only scopes keeps the secret sealed and decryptable (Review Focus 5)", async () => {
  const organizationId = await createOrganization();
  const providerId = await registerProvider(organizationId, PLAIN_SECRET);

  const update = await jsonRequest("/sso/update-provider", {
    providerId,
    oidcConfig: { scopes: ["openid", "email", "profile"] },
  });
  assert.equal(update.status, 200, await update.clone().text());

  const stored = await rawOidcConfig(providerId);
  assert.ok(!stored.includes(PLAIN_SECRET));
  const parsed = JSON.parse(stored);
  assert.deepEqual(parsed.scopes, ["openid", "email", "profile"]);
  const decrypted = await teamSecrets.decryptTeamSecret(
    (parsed.clientSecret as string).slice(
      secretStorage.SEALED_SECRET_PREFIX.length,
    ),
    organizationId,
  );
  assert.equal(decrypted, PLAIN_SECRET);
}, 60_000);

test("a legacy plaintext row stays readable and is sealed on the next write", async () => {
  const organizationId = await createOrganization();
  const providerId = await registerProvider(organizationId, PLAIN_SECRET);

  // Simulate a row written before encryption existed: overwrite the column
  // directly (bypassing the wrapper) with a plaintext clientSecret.
  const legacyConfig = JSON.stringify({
    issuer: "https://idp.example.com",
    clientId: "client-123",
    clientSecret: "legacy-plain",
    tokenEndpointAuthentication: "client_secret_basic",
    scopes: ["openid", "email"],
    ...oidcEndpoints(),
  });
  await schema.database.query(
    `update "ssoProvider" set "oidcConfig" = $1 where "providerId" = $2`,
    [legacyConfig, providerId],
  );
  assert.equal(await storedClientSecret(providerId), "legacy-plain");

  // Still readable: open() returns an unprefixed value verbatim, so the read
  // endpoint does not choke on it.
  const get = await request(
    `/sso/get-provider?providerId=${encodeURIComponent(providerId)}`,
  );
  assert.equal(get.status, 200, await get.clone().text());

  // Next write seals it.
  const update = await jsonRequest("/sso/update-provider", {
    providerId,
    oidcConfig: { scopes: ["openid"] },
  });
  assert.equal(update.status, 200, await update.clone().text());

  const sealed = await storedClientSecret(providerId);
  assert.ok(
    sealed.startsWith(secretStorage.SEALED_SECRET_PREFIX),
    "the legacy plaintext secret should be sealed after the write",
  );
  const decrypted = await teamSecrets.decryptTeamSecret(
    sealed.slice(secretStorage.SEALED_SECRET_PREFIX.length),
    organizationId,
  );
  assert.equal(decrypted, "legacy-plain");
}, 60_000);
