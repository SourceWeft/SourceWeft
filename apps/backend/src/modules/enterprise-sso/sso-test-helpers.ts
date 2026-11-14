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

/** Boot auth (migration mode) against a fresh isolated database. */
export async function bootSsoTestHarness(
  label: string,
): Promise<SsoTestHarness> {
  const isolated = await createIsolatedTestDatabase(label);
  process.env.DATABASE_URL = isolated.url;

  const schema = await import("@sourceweft/db");
  const authConfig = await import("../auth/auth-config");
  const sharedConfig = await import("../../shared/config");
  const baseUrl = sharedConfig.config.auth.baseUrl;

  const auth = authConfig.createSourceweftAuth({ mode: "migration" });
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
 * A cookie-jar-backed HTTP client for one signed-in user. Each instance keeps
 * its own jar, so several users can act against the same auth handler.
 */
export class SsoTestClient {
  private readonly jar = new Map<string, string>();

  constructor(
    private readonly auth: SourceweftAuth,
    private readonly baseUrl: string,
  ) {}

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

/** Sign a fresh user up (email/password) and return an authenticated client. */
export async function signUpUser(
  harness: SsoTestHarness,
  name: string,
): Promise<SsoTestUser> {
  // Lowercase so the generated address survives better-auth's email
  // normalization unchanged and the lookup below matches.
  const email = `${name.toLowerCase()}-${randomUUID()}@sourceweft.test`;
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
