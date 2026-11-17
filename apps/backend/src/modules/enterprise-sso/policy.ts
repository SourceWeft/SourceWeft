import { domainToASCII } from "node:url";
import { parse as parseDomain } from "tldts";
import { parseSourceweftOrganizationKind } from "../auth/organization-metadata";
import { SSO_ERROR_CODES, ssoError } from "./errors";
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

/**
 * Normalize an SSO provider domain to a canonical, lowercase, ASCII hostname.
 *
 * Trims surrounding whitespace, lowercases, drops a single leading `@` (so an
 * email-style `@acme.com` is accepted) and any trailing dots, then IDNA/punycode
 * encodes internationalized labels (`bücher.example` → `xn--bcher-kva.example`).
 *
 * A subdomain is preserved as written — `mail.acme.com` never collapses to
 * `acme.com` — so domain *uniqueness* is judged on the exact label a tenant
 * registers (one tenant owning `acme.com` does not reserve `mail.acme.com` for
 * itself through normalization). Sign-in routing, separately, does trust a
 * verified parent for its subdomains (see {@link ssoDomainCandidates}).
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
    throw ssoError(SSO_ERROR_CODES.domainNotAllowed, "BAD_REQUEST");
  }

  const ascii = domainToASCII(stripped);
  if (!ascii || !ASCII_HOSTNAME_PATTERN.test(ascii)) {
    throw ssoError(SSO_ERROR_CODES.domainNotAllowed, "BAD_REQUEST");
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

/**
 * Whether `domain` is itself a public suffix — a shared registration point
 * under which anyone can create names (`co.uk`, `github.io`, `herokuapp.com`,
 * `blogspot.com`), including the PRIVATE suffixes the Public Suffix List marks.
 * A provider verified for such a suffix would, through sign-in's parent-domain
 * trust, be trusted for every subdomain anyone else could register under it, so
 * these can never be claimed. `tldts` with `allowPrivateDomains: true` reports no
 * registrable domain for a bare public (or private) suffix.
 *
 * `domain` must already be normalized via {@link normalizeSsoDomain}.
 */
export function isPublicSuffixDomain(domain: string): boolean {
  return parseDomain(domain, { allowPrivateDomains: true }).domain === null;
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
 *  - a bare public suffix (`co.uk`, `github.io`, …; see
 *    {@link isPublicSuffixDomain});
 *  - a domain that already has a provider in the *same* organization (sign-in
 *    routes by domain, so one provider per domain per org);
 *  - a domain owned by a *verified* provider of another organization.
 *
 * An *unverified* claim by another organization does **not** block: ownership
 * is only established by verification, so an unverified squatter cannot stop the
 * real owner from registering and verifying the domain. Uniqueness is judged on
 * the exact label: `acme.com` and `mail.acme.com` are distinct here (sign-in
 * routing separately trusts a verified parent for a subdomain). The provider
 * named by `excludeProviderId` (the row being updated) is skipped.
 *
 * `domain` must already be normalized via {@link normalizeSsoDomain}.
 */
export async function assertSsoDomainAllowed(
  input: { domain: string; organizationId: string; excludeProviderId?: string },
  lookup: SsoProviderDomainLookup,
): Promise<void> {
  if (isPublicEmailDomain(input.domain) || isPublicSuffixDomain(input.domain)) {
    throw ssoError(SSO_ERROR_CODES.domainNotAllowed, "BAD_REQUEST");
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
      throw ssoError(SSO_ERROR_CODES.domainNotAllowed, "BAD_REQUEST");
    }
    if (row.domainVerified) {
      throw ssoError(SSO_ERROR_CODES.domainNotAllowed, "BAD_REQUEST");
    }
  }
}

/**
 * The domain itself, then each parent domain up to (and including) the
 * registrable domain, in nearest-first order. Used to route email-based SSO
 * sign-in: an exact verified match is preferred, then the nearest verified
 * parent. The walk stops at the registrable domain (`tldts`, with
 * `allowPrivateDomains: true`), so it never ascends into a public suffix —
 * neither an ICANN one (`com`, `co.uk`) nor a PRIVATE one (`github.io`,
 * `herokuapp.com`), under which anyone can register a sibling name.
 *
 * `domain` must already be normalized via {@link normalizeSsoDomain}.
 */
export function ssoDomainCandidates(domain: string): string[] {
  const candidates = [domain];
  const registrable = parseDomain(domain, { allowPrivateDomains: true }).domain;
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
    throw ssoError(SSO_ERROR_CODES.organizationRequired, "BAD_REQUEST");
  }
}
