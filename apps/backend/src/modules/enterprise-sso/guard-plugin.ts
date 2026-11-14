import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { SSO_ERROR_CODES } from "./errors";
import {
  assertSsoDomainAllowed,
  assertTeamOrganization,
  normalizeSsoDomain,
  ssoDomainCandidates,
  type SsoProviderDomainLookup,
  type SsoProviderDomainRow,
} from "./policy";

/**
 * Tenant-policy guard for `@better-auth/sso` provider registration, updates,
 * domain verification and email-based sign-in routing.
 *
 * The official plugin already rejects non-members (400) and non-admins (403),
 * hides other organizations' providers, and SSRF-checks OIDC endpoints. This
 * guard adds the SourceWeft multi-tenant rules the plugin cannot know:
 *
 *  - register/update: a provider must belong to a `team` organization; its
 *    domain is normalized, must be private (no public mailbox provider), must be
 *    unique within its organization, and must not be verified by another
 *    organization (an unverified claim by another org does not block — ownership
 *    is established by verification). A team is capped at
 *    {@link MAX_PROVIDERS_PER_ORGANIZATION} providers, and a SAML provider always
 *    stores `wantAssertionsSigned: true`.
 *  - verify-domain: a domain already verified by another organization cannot be
 *    verified again. A partial unique index backstops the check against races;
 *    its violation is mapped to a clean `SSO_DOMAIN_NOT_ALLOWED` (see
 *    {@link VERIFIED_DOMAIN_UNIQUE_INDEX}).
 *  - sign-in: email/domain sign-in is routed to the exact verified provider,
 *    else the nearest verified parent domain, making unverified squatter rows
 *    invisible. No verified match is a 404 `SSO_PROVIDER_NOT_FOUND`.
 *
 * Rejections throw a better-auth `APIError` whose JSON body `code` is the
 * matching {@link SSO_ERROR_CODES} value.
 */

const REGISTER_PATH = "/sso/register";
const UPDATE_PATH = "/sso/update-provider";
const VERIFY_DOMAIN_PATH = "/sso/verify-domain";
const SIGN_IN_PATH = "/sign-in/sso";
const SSO_PROVIDER_MODEL = "ssoProvider";

/**
 * Maximum SSO providers one organization may own. The plugin's `providersLimit`
 * caps providers per registering user; this caps them per tenant.
 */
export const MAX_PROVIDERS_PER_ORGANIZATION = 5;

/**
 * Name of the partial unique index (added by a SQL migration) that enforces one
 * verified provider per domain across all organizations. A write that violates
 * it is mapped to {@link SSO_ERROR_CODES.domainNotAllowed} instead of a 500.
 */
export const VERIFIED_DOMAIN_UNIQUE_INDEX = "sso_provider_verified_domain_unique";

/** The narrow slice of the better-auth adapter this guard reads. */
type GuardAdapter = {
  findMany: (args: {
    model: string;
    where?: Array<{ field: string; value: unknown; operator?: string }>;
    select?: string[];
  }) => Promise<Array<Record<string, unknown>>>;
  findOne: (args: {
    model: string;
    where?: Array<{ field: string; value: unknown }>;
    select?: string[];
  }) => Promise<Record<string, unknown> | null>;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function domainNotAllowed(message: string): APIError {
  return new APIError("BAD_REQUEST", {
    code: SSO_ERROR_CODES.domainNotAllowed,
    message,
  });
}

function toDomainRow(row: Record<string, unknown>): SsoProviderDomainRow {
  return {
    providerId: String(row.providerId ?? ""),
    organizationId: asString(row.organizationId),
    domain: String(row.domain ?? ""),
    domainVerified: row.domainVerified === true,
  };
}

/** Lookup of existing providers sharing a domain, backed by the auth adapter. */
function domainLookup(adapter: GuardAdapter): SsoProviderDomainLookup {
  return async (domain) => {
    const rows = await adapter.findMany({
      model: SSO_PROVIDER_MODEL,
      where: [{ field: "domain", value: domain }],
      select: ["providerId", "organizationId", "domain", "domainVerified"],
    });
    return rows.map(toDomainRow);
  };
}

/** Force `samlConfig.wantAssertionsSigned` to true when a SAML config is present. */
function withSignedAssertions(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const samlConfig = body.samlConfig;
  if (!samlConfig || typeof samlConfig !== "object") {
    return body;
  }
  return {
    ...body,
    samlConfig: {
      ...(samlConfig as Record<string, unknown>),
      wantAssertionsSigned: true,
    },
  };
}

/** The domain part after the last `@`, or null for a value without one. */
function emailDomain(email: string | null): string | null {
  if (!email) {
    return null;
  }
  const at = email.lastIndexOf("@");
  if (at < 0) {
    return null;
  }
  const domain = email.slice(at + 1);
  return domain.length > 0 ? domain : null;
}

async function handleRegister(
  ctx: { body?: Record<string, unknown> },
  adapter: GuardAdapter,
) {
  const body = ctx.body as Record<string, unknown>;
  const organizationId = asString(body.organizationId);
  if (!organizationId) {
    throw new APIError("BAD_REQUEST", {
      code: SSO_ERROR_CODES.organizationRequired,
      message: "An SSO provider must be registered to a team organization.",
    });
  }
  await assertTeamOrganization(organizationId);

  const existing = await adapter.findMany({
    model: SSO_PROVIDER_MODEL,
    where: [{ field: "organizationId", value: organizationId }],
    select: ["providerId"],
  });
  if (existing.length >= MAX_PROVIDERS_PER_ORGANIZATION) {
    throw new APIError("BAD_REQUEST", {
      code: SSO_ERROR_CODES.providerLimit,
      message: `An organization may have at most ${MAX_PROVIDERS_PER_ORGANIZATION} SSO providers.`,
    });
  }

  const domain = normalizeSsoDomain(String(body.domain ?? ""));
  await assertSsoDomainAllowed({ domain, organizationId }, domainLookup(adapter));

  return { context: { body: withSignedAssertions({ ...body, domain }) } };
}

async function handleUpdate(
  ctx: { body?: Record<string, unknown> },
  adapter: GuardAdapter,
) {
  const body = ctx.body as Record<string, unknown>;
  const providerId = asString(body.providerId);
  const nextBody: Record<string, unknown> = { ...body };

  if (typeof body.domain === "string") {
    const domain = normalizeSsoDomain(body.domain);
    const current = providerId
      ? await adapter.findOne({
          model: SSO_PROVIDER_MODEL,
          where: [{ field: "providerId", value: providerId }],
          select: ["providerId", "organizationId", "domain"],
        })
      : null;
    const organizationId = asString(current?.organizationId);
    // An org-less provider cannot be re-domained here: the plugin's
    // guardProviderMutation rejects the mutation outright. For a team-owned
    // provider, enforce the same domain policy as register, excluding itself.
    if (organizationId) {
      await assertSsoDomainAllowed(
        { domain, organizationId, excludeProviderId: providerId ?? undefined },
        domainLookup(adapter),
      );
    }
    nextBody.domain = domain;
  }

  return { context: { body: withSignedAssertions(nextBody) } };
}

async function handleVerifyDomain(
  ctx: { body?: Record<string, unknown> },
  adapter: GuardAdapter,
) {
  const providerId = asString(ctx.body?.providerId);
  if (!providerId) {
    return; // the plugin validates the body / 404s a missing provider
  }
  const current = await adapter.findOne({
    model: SSO_PROVIDER_MODEL,
    where: [{ field: "providerId", value: providerId }],
    select: ["providerId", "organizationId", "domain"],
  });
  if (!current) {
    return;
  }
  const organizationId = asString(current.organizationId);
  const domain = String(current.domain ?? "").toLowerCase();
  if (!domain) {
    return;
  }
  const rows = await domainLookup(adapter)(domain);
  const conflict = rows.some(
    (row) =>
      row.domain === domain &&
      row.domainVerified &&
      row.organizationId !== null &&
      row.organizationId !== organizationId,
  );
  if (conflict) {
    throw domainNotAllowed(
      `"${domain}" is already verified by another organization.`,
    );
  }
}

async function handleSignInRouting(
  ctx: { body?: Record<string, unknown> },
  adapter: GuardAdapter,
) {
  const body = ctx.body as Record<string, unknown> | undefined;
  if (!body) {
    return;
  }
  // Only resolve when the caller did not name a provider or organization.
  if (asString(body.providerId) || asString(body.organizationSlug)) {
    return;
  }
  const raw = asString(body.domain) ?? emailDomain(asString(body.email));
  if (!raw) {
    return; // nothing to resolve from; let the plugin handle it
  }

  let domain: string;
  try {
    domain = normalizeSsoDomain(raw);
  } catch {
    throw new APIError("NOT_FOUND", {
      code: SSO_ERROR_CODES.providerNotFound,
      message: "No verified SSO provider matches this email domain.",
    });
  }

  const candidates = ssoDomainCandidates(domain);
  const rows = await adapter.findMany({
    model: SSO_PROVIDER_MODEL,
    where: [
      { field: "domain", value: candidates, operator: "in" },
      { field: "domainVerified", value: true },
    ],
    select: ["providerId", "domain", "domainVerified"],
  });

  // Exact match first, then the nearest verified parent domain.
  for (const candidate of candidates) {
    const match = rows.find(
      (row) => String(row.domain) === candidate && row.domainVerified === true,
    );
    if (match) {
      return {
        context: { body: { ...body, providerId: String(match.providerId) } },
      };
    }
  }

  throw new APIError("NOT_FOUND", {
    code: SSO_ERROR_CODES.providerNotFound,
    message: "No verified SSO provider matches this email domain.",
  });
}

/** Whether an error is the verified-domain unique-index violation. */
function isVerifiedDomainUniqueViolation(error: unknown): boolean {
  const err = error as {
    code?: string;
    constraint?: string;
    detail?: string;
    message?: string;
    cause?: unknown;
  };
  const pg = (err?.cause ?? err) as {
    code?: string;
    constraint?: string;
    detail?: string;
    message?: string;
  };
  if (pg?.code !== "23505" && err?.code !== "23505") {
    return false;
  }
  const haystack = `${pg?.constraint ?? ""} ${pg?.detail ?? ""} ${pg?.message ?? ""} ${err?.message ?? ""}`;
  return haystack.includes(VERIFIED_DOMAIN_UNIQUE_INDEX);
}

/**
 * Wrap the adapter so that a unique-index violation from setting a provider's
 * `domainVerified` (the only path that sets it true is `incrementOne` in the
 * plugin's `completeDomainVerification`) surfaces as a clean
 * {@link SSO_ERROR_CODES.domainNotAllowed} instead of a 500. This is the
 * race-safe backstop for two concurrent verifications of the same domain.
 */
function wrapAdapterForVerifiedDomainUniqueness<T extends object>(
  adapter: T,
): T {
  const base = adapter as {
    incrementOne?: (args: { model?: string }) => Promise<unknown>;
  };
  if (typeof base.incrementOne !== "function") {
    return adapter;
  }
  return new Proxy(adapter, {
    get(target, property, receiver) {
      if (property === "incrementOne") {
        return async (args: { model?: string }) => {
          try {
            return await base.incrementOne!(args);
          } catch (error) {
            if (
              args?.model === SSO_PROVIDER_MODEL &&
              isVerifiedDomainUniqueViolation(error)
            ) {
              throw domainNotAllowed(
                "This domain is already verified by another organization.",
              );
            }
            throw error;
          }
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

export function sourceweftSsoGuard(): BetterAuthPlugin {
  return {
    id: "sourceweft-sso-guard",
    init(ctx) {
      return {
        context: {
          adapter: wrapAdapterForVerifiedDomainUniqueness(ctx.adapter),
        },
      };
    },
    hooks: {
      before: [
        {
          matcher: (context) =>
            context.path === REGISTER_PATH || context.path === UPDATE_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            if (!ctx.body) {
              return;
            }
            const adapter = ctx.context.adapter as unknown as GuardAdapter;
            return ctx.path === REGISTER_PATH
              ? handleRegister(ctx, adapter)
              : handleUpdate(ctx, adapter);
          }),
        },
        {
          matcher: (context) => context.path === VERIFY_DOMAIN_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const adapter = ctx.context.adapter as unknown as GuardAdapter;
            return handleVerifyDomain(ctx, adapter);
          }),
        },
        {
          matcher: (context) => context.path === SIGN_IN_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const adapter = ctx.context.adapter as unknown as GuardAdapter;
            return handleSignInRouting(ctx, adapter);
          }),
        },
      ],
    },
  };
}
