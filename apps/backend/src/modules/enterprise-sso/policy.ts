import { domainToASCII } from "node:url";
import { APIError } from "better-auth/api";
import { parse as parseDomain } from "tldts";
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
    throw domainNotAllowed("This domain cannot be used for single sign-on.");
  }

  const ascii = domainToASCII(stripped);
  if (!ascii || !ASCII_HOSTNAME_PATTERN.test(ascii)) {
    throw domainNotAllowed("This domain cannot be used for single sign-on.");
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
  domainVerified: boolean;
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
 * Rejects (with {@link SSO_ERROR_CODES.domainNotAllowed}):
 *  - a public mailbox domain;
 *  - a domain that already has a provider in the *same* organization (sign-in
 *    routes by domain, so one provider per domain per org);
 *  - a domain owned by a *verified* provider of another organization.
 *
 * An *unverified* claim by another organization does **not** block: ownership
 * is only established by verification, so an unverified squatter cannot stop the
 * real owner from registering and verifying the domain. Domain identity is
 * exact: `acme.com` and `mail.acme.com` are distinct (plan Review Focus 3). The
 * provider named by `excludeProviderId` (the row being updated) is skipped.
 *
 * `domain` must already be normalized via {@link normalizeSsoDomain}.
 */
export async function assertSsoDomainAllowed(
  input: { domain: string; organizationId: string; excludeProviderId?: string },
  lookup: SsoProviderDomainLookup,
): Promise<void> {
  if (isPublicEmailDomain(input.domain)) {
    throw domainNotAllowed("This domain cannot be used for single sign-on.");
  }

  const rows = await lookup(input.domain);
  for (const row of rows) {
    if (row.domain !== input.domain) {
      continue;
    }
    if (row.providerId === input.excludeProviderId) {
      continue;
    }
    if (row.organizationId === null) {
      continue;
    }
    if (row.organizationId === input.organizationId) {
      throw domainNotAllowed("This domain cannot be used for single sign-on.");
    }
    if (row.domainVerified) {
      throw domainNotAllowed("This domain cannot be used for single sign-on.");
    }
  }
}

/**
 * The domain itself, then each parent domain up to (and including) the
 * registrable domain, in nearest-first order. Used to route email-based SSO
 * sign-in: an exact verified match is preferred, then the nearest verified
 * parent. The walk stops at the registrable domain (`tldts`), so it never
 * ascends into a public suffix (`com`, `co.uk`, `example`).
 *
 * `domain` must already be normalized via {@link normalizeSsoDomain}.
 */
export function ssoDomainCandidates(domain: string): string[] {
  const candidates = [domain];
  const registrable = parseDomain(domain).domain;
  if (!registrable || registrable === domain) {
    return candidates;
  }
  let current = domain;
  while (current !== registrable && current.includes(".")) {
    const parent = current.slice(current.indexOf(".") + 1);
    if (!parent || parent === current) {
      break;
    }
    candidates.push(parent);
    current = parent;
  }
  return candidates;
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
    throw organizationRequired("Single sign-on can only be set up for a team.");
  }
}
