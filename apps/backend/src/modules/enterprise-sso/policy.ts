import { domainToASCII } from "node:url";
import { APIError } from "better-auth/api";
import { parseSourceweftOrganizationKind } from "../auth/organization-metadata";
import { SSO_ERROR_CODES } from "./errors";
import { PUBLIC_EMAIL_DOMAINS } from "./public-email-domains";

/**
 * Domain and tenant policy for enterprise SSO provider registration.
 *
 * These rules are the multi-tenant isolation layer: they stop one team from
 * claiming another team's — or a public mailbox provider's — email domain, and
 * confine identity sources to `team` organizations. Account linking elsewhere
 * trusts a verified domain whose email domain matches, so a domain claimed by
 * the wrong tenant is an account-takeover vector; everything here fails closed.
 */

/** A pre-IDN domain contains only letters, digits, hyphens and dot separators. */
const DOMAIN_INPUT_PATTERN = /^[\p{L}\p{N}.-]+$/u;

/**
 * A registrable hostname of at least two labels. Each label is 1–63 chars of
 * `[a-z0-9-]` that neither starts nor ends with a hyphen; the whole name is at
 * most 253 chars. Applied to the punycoded (ASCII) form.
 */
const ASCII_HOSTNAME_PATTERN =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function domainNotAllowed(message: string): APIError {
  return new APIError("BAD_REQUEST", {
    code: SSO_ERROR_CODES.domainNotAllowed,
    message,
  });
}

function organizationRequired(message: string): APIError {
  return new APIError("BAD_REQUEST", {
    code: SSO_ERROR_CODES.organizationRequired,
    message,
  });
}

/**
 * Normalize an SSO provider domain to a canonical, lowercase, ASCII hostname.
 *
 * Trims surrounding whitespace, lowercases, drops a single leading `@` (so an
 * email-style `@acme.com` is accepted) and any trailing dots, then IDNA/punycode
 * encodes internationalized labels (`bücher.example` → `xn--bcher-kva.example`).
 *
 * A subdomain is preserved as written — `mail.acme.com` never collapses to
 * `acme.com` — because the parent's verification must not be treated as
 * covering a subdomain (plan Review Focus 3).
 *
 * Throws {@link SSO_ERROR_CODES.domainNotAllowed} for anything that is not a
 * bare multi-label hostname: empty input, embedded paths/ports/spaces
 * (`acme.com/path`, `acme.com:8080`, `not a domain`), or a single label
 * (`acme`). `domainToASCII` silently truncates a path or query, so the raw
 * input is character-checked before encoding rather than relying on it.
 */
export function normalizeSsoDomain(input: string): string {
  const stripped = input
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/\.+$/, "");

  if (!stripped || !DOMAIN_INPUT_PATTERN.test(stripped)) {
    throw domainNotAllowed(`"${input}" is not a valid SSO domain.`);
  }

  const ascii = domainToASCII(stripped);
  if (!ascii || !ASCII_HOSTNAME_PATTERN.test(ascii)) {
    throw domainNotAllowed(`"${input}" is not a valid SSO domain.`);
  }

  return ascii;
}

/**
 * Whether `domain` is a shared consumer mailbox provider that no single tenant
 * may claim. Expects an already-normalized domain; compares case-insensitively
 * for safety.
 */
export function isPublicEmailDomain(domain: string): boolean {
  return PUBLIC_EMAIL_DOMAINS.has(domain.toLowerCase());
}

/** One `ssoProvider` row relevant to domain-uniqueness checks. */
export type SsoProviderDomainRow = {
  providerId: string;
  organizationId: string | null;
  domain: string;
};

/**
 * Finds every existing `ssoProvider` whose domain could collide with a
 * candidate. The guard supplies an adapter-backed implementation; tests inject
 * a fake so the policy logic is exercised without a database.
 */
export type SsoProviderDomainLookup = (
  domain: string,
) => Promise<SsoProviderDomainRow[]>;

/**
 * Assert that `domain` may be registered or kept by `organizationId`.
 *
 * Rejects (with {@link SSO_ERROR_CODES.domainNotAllowed}) a public mailbox
 * domain, or a domain already registered by a *different* organization. Domain
 * identity is exact: `acme.com` and `mail.acme.com` are distinct, so claiming
 * one never conflicts with the other (plan Review Focus 3). Rows owned by the
 * same organization — and the provider named by `excludeProviderId`, i.e. the
 * row being updated — are not conflicts.
 *
 * `domain` must already be normalized via {@link normalizeSsoDomain}.
 */
export async function assertSsoDomainAllowed(
  input: { domain: string; organizationId: string; excludeProviderId?: string },
  lookup: SsoProviderDomainLookup,
): Promise<void> {
  if (isPublicEmailDomain(input.domain)) {
    throw domainNotAllowed(
      `"${input.domain}" is a public email domain and cannot be used for SSO.`,
    );
  }

  const rows = await lookup(input.domain);
  const conflict = rows.some(
    (row) =>
      row.domain === input.domain &&
      row.organizationId !== null &&
      row.organizationId !== input.organizationId &&
      row.providerId !== input.excludeProviderId,
  );

  if (conflict) {
    throw domainNotAllowed(
      `"${input.domain}" is already registered to another organization.`,
    );
  }
}

/**
 * Assert that `organizationId` is a SourceWeft `team` organization. Identity
 * sources belong only to team organizations; a personal organization, an
 * unknown id, or one with no SourceWeft kind is rejected with
 * {@link SSO_ERROR_CODES.organizationRequired}.
 *
 * `workspaceService` is imported lazily to avoid an import cycle with
 * `auth-config` (the organization hooks there do the same).
 */
export async function assertTeamOrganization(
  organizationId: string,
): Promise<void> {
  const { workspaceService } = await import("../workspace");
  const organization = await workspaceService.getOrganization(organizationId);
  if (
    !organization ||
    parseSourceweftOrganizationKind(organization.metadata) !== "team"
  ) {
    throw organizationRequired(
      "An SSO provider must belong to a team organization.",
    );
  }
}
