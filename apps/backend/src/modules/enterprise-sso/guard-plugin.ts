import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { SSO_ERROR_CODES } from "./errors";
import {
  assertSsoDomainAllowed,
  assertTeamOrganization,
  normalizeSsoDomain,
  type SsoProviderDomainLookup,
  type SsoProviderDomainRow,
} from "./policy";

/**
 * Tenant-policy guard for `@better-auth/sso` provider registration and updates.
 *
 * The official plugin already rejects non-members (400) and non-admins (403),
 * hides other organizations' providers, and SSRF-checks OIDC endpoints. This
 * guard adds the SourceWeft multi-tenant rules the plugin cannot know:
 *
 *  - a provider must belong to a `team` organization (`organizationId` required;
 *    personal or unknown organizations are rejected);
 *  - its domain is normalized, must be a private hostname (no public mailbox
 *    provider), and must not already be registered to another organization;
 *  - a team is capped at {@link MAX_PROVIDERS_PER_ORGANIZATION} providers (the
 *    plugin's own `providersLimit` is the per-user cap);
 *  - a SAML provider always stores `wantAssertionsSigned: true`.
 *
 * It runs as a `before` hook so the normalized domain and forced SAML flag are
 * what the plugin persists. Rejections throw a better-auth `APIError` whose JSON
 * body carries the matching {@link SSO_ERROR_CODES} value.
 */

const REGISTER_PATH = "/sso/register";
const UPDATE_PATH = "/sso/update-provider";
const SSO_PROVIDER_MODEL = "ssoProvider";

/**
 * Maximum SSO providers one organization may own. The plugin's `providersLimit`
 * caps providers per registering user; this caps them per tenant.
 */
export const MAX_PROVIDERS_PER_ORGANIZATION = 5;

/** The narrow slice of the better-auth adapter this guard reads. */
type GuardAdapter = {
  findMany: (args: {
    model: string;
    where?: Array<{ field: string; value: unknown }>;
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

function toDomainRow(row: Record<string, unknown>): SsoProviderDomainRow {
  return {
    providerId: String(row.providerId ?? ""),
    organizationId: asString(row.organizationId),
    domain: String(row.domain ?? ""),
  };
}

/** Lookup of existing providers sharing a domain, backed by the auth adapter. */
function domainLookup(adapter: GuardAdapter): SsoProviderDomainLookup {
  return async (domain) => {
    const rows = await adapter.findMany({
      model: SSO_PROVIDER_MODEL,
      where: [{ field: "domain", value: domain }],
      select: ["providerId", "organizationId", "domain"],
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

export function sourceweftSsoGuard(): BetterAuthPlugin {
  return {
    id: "sourceweft-sso-guard",
    hooks: {
      before: [
        {
          matcher: (context) =>
            context.path === REGISTER_PATH || context.path === UPDATE_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const body = ctx.body as Record<string, unknown> | undefined;
            if (!body) {
              return;
            }
            const adapter = ctx.context.adapter as unknown as GuardAdapter;

            if (ctx.path === REGISTER_PATH) {
              const organizationId = asString(body.organizationId);
              if (!organizationId) {
                throw new APIError("BAD_REQUEST", {
                  code: SSO_ERROR_CODES.organizationRequired,
                  message:
                    "An SSO provider must be registered to a team organization.",
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
              await assertSsoDomainAllowed(
                { domain, organizationId },
                domainLookup(adapter),
              );

              return {
                context: {
                  body: withSignedAssertions({ ...body, domain }),
                },
              };
            }

            // UPDATE_PATH
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
              // guardProviderMutation rejects the mutation outright. For a
              // team-owned provider, enforce the same domain policy as register
              // (public-domain and cross-tenant uniqueness), excluding itself.
              if (organizationId) {
                await assertSsoDomainAllowed(
                  { domain, organizationId, excludeProviderId: providerId ?? undefined },
                  domainLookup(adapter),
                );
              }
              nextBody.domain = domain;
            }

            return { context: { body: withSignedAssertions(nextBody) } };
          }),
        },
      ],
    },
  };
}
