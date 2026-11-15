import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

/**
 * Shared boot + request machinery for the enterprise-SSO database suites.
 *
 * Auth is booted in "migration" mode against an isolated clone of the migrated
 * template database: it runs every plugin's `init` (so the secret-storage
 * wrapper and the SSO guard are installed) while skipping the runtime-only mail,
 * onboarding and billing hooks. DATABASE_URL is repointed at the clone before
 * any DB-bound module is imported, so the shared `@sourceweft/db` singleton
 * targets this suite's own database.
 *
 * Because migration mode skips the organization hooks that tag a SourceWeft
 * organization's `kind`, organizations are created here directly in SQL with
 * explicit `kind` metadata and membership, which is deterministic and matches
 * the rows production writes.
 */

type DbModule = typeof import("@sourceweft/db");
type SourceweftAuth = ReturnType<
  typeof import("../auth/auth-config").createSourceweftAuth
>;

export type SsoTestHarness = {
  isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  schema: DbModule;
  auth: SourceweftAuth;
  baseUrl: string;
};

/**
 * Boot auth against a fresh isolated database.
 *
 * Defaults to "migration" mode (the plugin `init`s run, runtime-only mail/
 * onboarding/billing hooks do not) — enough for the provider-lifecycle suites.
 * Pass `mode: "runtime"` for the suites that must exercise the real
 * organization and session hooks (JIT membership, personal-org provisioning,
 * shared-workspace access): mail delivery is not configured in the test env
 * (`mailDeliveryConfigured()` is false), so the runtime mail callbacks resolve
 * to the console provider and send nothing.
 *
 * `trustedOrigins` are appended to this auth instance's trusted origins before
 * it is built. Tests pass a loopback mock IdP's origin so the plugin's SSRF
 * guard admits it — the documented escape hatch for an internal IdP. This is
 * test-only and never touches production configuration.
 */
export async function bootSsoTestHarness(
  label: string,
  options: {
    mode?: "runtime" | "migration";
    trustedOrigins?: string[];
  } = {},
): Promise<SsoTestHarness> {
  const isolated = await createIsolatedTestDatabase(label);
  process.env.DATABASE_URL = isolated.url;

  const schema = await import("@sourceweft/db");
  const authConfig = await import("../auth/auth-config");
  const sharedConfig = await import("../../shared/config");
  const baseUrl = sharedConfig.config.auth.baseUrl;

  for (const origin of options.trustedOrigins ?? []) {
    if (!sharedConfig.config.auth.trustedOrigins.includes(origin)) {
      sharedConfig.config.auth.trustedOrigins.push(origin);
    }
  }

  const auth = authConfig.createSourceweftAuth({
    mode: options.mode ?? "migration",
  });
  await auth.$context;

  return { isolated, schema, auth, baseUrl };
}

/** Tear down the DB pool and drop the isolated database. */
export async function closeSsoTestHarness(
  harness: SsoTestHarness | undefined,
): Promise<void> {
  await harness?.schema.database.end();
  await harness?.isolated.close();
}

/**
 * Distinct client IP per {@link SsoTestClient}. better-auth rate-limits per
 * `IP + path` (reading `x-forwarded-for` by default, falling back to a single
 * `127.0.0.1` in test mode), and `/sign-in/*` has a built-in cap of 3 per 10s.
 * Giving each client its own IP keeps unrelated test requests in separate
 * buckets, which is also how real distinct clients are treated.
 */
let clientIpCounter = 0;
function nextClientIp(): string {
  clientIpCounter += 1;
  const n = clientIpCounter;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

/**
 * A cookie-jar-backed HTTP client for one signed-in user. Each instance keeps
 * its own jar and its own client IP, so several users (and one-off anonymous
 * callers) act against the same auth handler without sharing rate-limit buckets.
 */
export class SsoTestClient {
  private readonly jar: Map<string, string>;
  private readonly ip = nextClientIp();

  constructor(
    private readonly auth: SourceweftAuth,
    private readonly baseUrl: string,
    sharedJar?: Map<string, string>,
  ) {
    this.jar = sharedJar ?? new Map();
  }

  /**
   * A sibling client that shares this one's cookie jar — so it is the same
   * signed-in session — but gets its own client IP and therefore its own
   * rate-limit bucket. Use this when one test-authenticated user issues many
   * requests against a per-IP-rate-limited path (e.g. `/sso/register`, capped
   * at 10/60s) across many assertions in a suite; a real distinct session
   * making one or two such calls would not trigger that limit either.
   */
  withFreshIp(): SsoTestClient {
    return new SsoTestClient(this.auth, this.baseUrl, this.jar);
  }

  /** Capture Set-Cookie into the jar; replay as a Cookie header. */
  private captureCookies(response: Response) {
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
        this.jar.set(name, value);
      } else {
        this.jar.delete(name);
      }
    }
  }

  private cookieHeader() {
    return [...this.jar.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("x-forwarded-for", this.ip);
    const cookie = this.cookieHeader();
    if (cookie) {
      headers.set("cookie", cookie);
    }
    const response = await this.auth.handler(
      new Request(`${this.baseUrl}/api/auth${path}`, { ...init, headers }),
    );
    this.captureCookies(response);
    return response;
  }

  jsonRequest(path: string, body: unknown, init: RequestInit = {}) {
    return this.request(path, {
      method: "POST",
      ...init,
      headers: { "content-type": "application/json", ...init.headers },
      body: JSON.stringify(body),
    });
  }
}

export type SsoTestUser = {
  client: SsoTestClient;
  userId: string;
  email: string;
};

/**
 * Sign a fresh user up (email/password) and return an authenticated client.
 * Pass `email` to control the address (e.g. to put the user on an SSO domain);
 * it is lowercased to survive better-auth's email normalization.
 */
export async function signUpUser(
  harness: SsoTestHarness,
  name: string,
  options: { email?: string } = {},
): Promise<SsoTestUser> {
  // Lowercase so the generated address survives better-auth's email
  // normalization unchanged and the lookup below matches.
  const email = (
    options.email ?? `${name.toLowerCase()}-${randomUUID()}@sourceweft.test`
  ).toLowerCase();
  const client = new SsoTestClient(harness.auth, harness.baseUrl);
  const response = await client.jsonRequest("/sign-up/email", {
    name,
    email,
    password: "correct horse battery staple",
  });
  assert.equal(response.status, 200, await response.clone().text());

  const result = await harness.schema.database.query<{ id: string }>(
    `select id from "user" where lower(email) = $1`,
    [email],
  );
  const userId = result.rows[0]?.id;
  assert.ok(userId, `expected a user row for ${email}`);
  return { client, userId, email };
}

/** Insert a `member` row directly (migration mode runs no membership hooks). */
export async function addOrganizationMember(
  harness: SsoTestHarness,
  input: { organizationId: string; userId: string; role: "owner" | "admin" | "member" },
): Promise<void> {
  await harness.schema.database.query(
    `insert into member (id, "organizationId", "userId", role, "createdAt")
     values ($1, $2, $3, $4, now())`,
    [randomUUID(), input.organizationId, input.userId, input.role],
  );
}

/**
 * Create an organization row with explicit SourceWeft `kind` metadata and make
 * `ownerUserId` its owner. Returns the organization id.
 */
export async function createOrganization(
  harness: SsoTestHarness,
  input: { ownerUserId: string; kind: "team" | "personal"; name?: string },
): Promise<string> {
  const id = randomUUID();
  const name =
    input.name ?? (input.kind === "team" ? "Team Org" : "Personal");
  await harness.schema.database.query(
    `insert into organization (id, name, slug, metadata, "createdAt")
     values ($1, $2, $3, $4, now())`,
    [
      id,
      name,
      `${input.kind}-${id.slice(0, 8)}`,
      JSON.stringify({ sourceweft: { kind: input.kind } }),
    ],
  );
  await addOrganizationMember(harness, {
    organizationId: id,
    userId: input.ownerUserId,
    role: "owner",
  });
  return id;
}

/** Mark a provider's domain verified directly in SQL (bypassing DNS checks). */
export async function setProviderDomainVerified(
  harness: SsoTestHarness,
  providerId: string,
): Promise<void> {
  await harness.schema.database.query(
    `update "ssoProvider" set "domainVerified" = true where "providerId" = $1`,
    [providerId],
  );
}

/**
 * Set a provider's role-mapping attributes directly in SQL. The register
 * endpoint does not accept these additionalFields in its body, so tests write
 * them straight to the columns (they carry no secret, so no adapter wrapper is
 * needed). `null` leaves the provider unconfigured for role mapping.
 */
export async function setProviderRoleMapping(
  harness: SsoTestHarness,
  providerId: string,
  input: { roleAttribute: string | null; adminRoleValue: string | null },
): Promise<void> {
  await harness.schema.database.query(
    `update "ssoProvider"
       set "roleAttribute" = $2, "adminRoleValue" = $3
     where "providerId" = $1`,
    [providerId, input.roleAttribute, input.adminRoleValue],
  );
}

/**
 * Insert an organization-less `ssoProvider` row directly in SQL, owned by
 * `userId`. Used to exercise the plugin's `guardProviderMutation`, which the
 * normal registration path can never produce (it requires a team organization).
 */
export async function insertOrphanProvider(
  harness: SsoTestHarness,
  input: { userId: string; domain: string },
): Promise<string> {
  const providerId = `orphan-${randomUUID()}`;
  await harness.schema.database.query(
    `insert into "ssoProvider"
       (id, "providerId", issuer, domain, "userId", "domainVerified", "organizationId")
     values ($1, $2, $3, $4, $5, false, null)`,
    [
      randomUUID(),
      providerId,
      "https://orphan.example.com",
      input.domain,
      input.userId,
    ],
  );
  return providerId;
}

/** Read the raw `ssoProvider` row straight from PostgreSQL (no adapter wrapper). */
export async function readStoredProvider(
  harness: SsoTestHarness,
  providerId: string,
): Promise<{
  organizationId: string | null;
  domain: string;
  domainVerified: boolean;
  oidcConfig: string | null;
  samlConfig: string | null;
}> {
  const result = await harness.schema.database.query<{
    organizationId: string | null;
    domain: string;
    domainVerified: boolean;
    oidcConfig: string | null;
    samlConfig: string | null;
  }>(
    `select "organizationId", "domain", "domainVerified", "oidcConfig", "samlConfig"
     from "ssoProvider" where "providerId" = $1`,
    [providerId],
  );
  const row = result.rows[0];
  assert.ok(row, `expected a stored ssoProvider row for ${providerId}`);
  return row;
}
