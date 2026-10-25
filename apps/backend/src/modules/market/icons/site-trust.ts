import { namespaceDomain } from "../claims/targets";
import { hostIsUnder, registrableDomainOf } from "./site-domain";

/**
 * Which website, if any, may be read for an entry's logo (Issue #367).
 *
 * Only evidence with a control relationship OUTSIDE the publisher's own
 * fields counts. Everything the registry file or the endpoint's `initialize`
 * answer says is the publisher speaking: a website named in both is one voice,
 * and a repository URL or owner name proves nothing about a domain.
 *
 * - **A** — the site is the publisher's by proof: the namespace is a domain
 *   the registry VERIFIED (the entry came from a verifying registry) and the
 *   entry's endpoint is under that domain, or a member's claim of the domain
 *   (DNS / well-known) was verified. A claim proves control of the listing and
 *   its domain; it never blesses a different homepage domain.
 * - **B** — the publisher declares a website AND the entry's endpoint host is
 *   under that site's registrable domain: whoever serves the endpoint there
 *   controls the domain's hosts, which no declaration can fake. (Registrable
 *   domains follow the Public Suffix List including shared hosts, so a
 *   project on `*.github.io` or `*.workers.dev` never speaks for the host.)
 * - **C** — anything else, including a single or repeated declaration: no
 *   automatic fetch; the declared site is only reported.
 */

export type SiteEvidence = {
  /** The reverse-DNS namespace of the entry. */
  namespace: string;
  /** The registry that listed the entry verifies namespace ownership. */
  namespaceVerified?: boolean;
  endpointUrl?: string;
  /** Registry `websiteUrl`. */
  registryWebsiteUrl?: string;
  /** `serverInfo.websiteUrl` from the endpoint's own `initialize` answer. */
  serverInfoWebsiteUrl?: string;
  /** The endpoint's protected-resource metadata `resource_documentation`. */
  resourceDocumentationUrl?: string;
  /** Domains whose DNS / well-known claim of this entry was verified. */
  claimedDomains?: readonly string[];
};

export type SiteTrust =
  | { tier: "A" | "B"; host: string; domain: string; reasons: string[] }
  | { tier: "C"; reasons: string[]; declaredDomains: string[] }
  | { tier: "none"; reasons: string[] };

function hostOfUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.username || url.password) return undefined;
    return url.hostname.toLowerCase().replace(/\.$/, "") || undefined;
  } catch {
    return undefined;
  }
}

export function evaluateSiteTrust(evidence: SiteEvidence): SiteTrust {
  const endpointHost = hostOfUrl(evidence.endpointUrl);

  // A, by a verified domain claim.
  for (const claimed of evidence.claimedDomains ?? []) {
    const domain = registrableDomainOf(claimed);
    if (domain) {
      return {
        tier: "A",
        host: claimed.toLowerCase(),
        domain,
        reasons: [`verified-claim:${claimed.toLowerCase()}`],
      };
    }
  }

  // A, by a verified namespace domain with the endpoint under it.
  const nsDomain = evidence.namespaceVerified
    ? namespaceDomain(evidence.namespace)
    : null;
  if (nsDomain && endpointHost && hostIsUnder(endpointHost, nsDomain)) {
    const domain = registrableDomainOf(nsDomain);
    if (domain) {
      return {
        tier: "A",
        host: nsDomain,
        domain,
        reasons: [`namespace-domain:${nsDomain}`, `endpoint-under:${endpointHost}`],
      };
    }
  }

  // B / C, from the declared websites.
  const declared = new Map<string, string[]>();
  for (const url of [
    evidence.registryWebsiteUrl,
    evidence.serverInfoWebsiteUrl,
    evidence.resourceDocumentationUrl,
  ]) {
    const host = hostOfUrl(url);
    const domain = host ? registrableDomainOf(host) : undefined;
    if (host && domain) declared.set(domain, [...(declared.get(domain) ?? []), host]);
  }
  if (declared.size === 0) {
    return { tier: "none", reasons: ["no-declared-site"] };
  }
  const endpointDomain = endpointHost ? registrableDomainOf(endpointHost) : undefined;
  for (const [domain, hosts] of declared) {
    if (!endpointHost || endpointDomain !== domain || !hostIsUnder(endpointHost, domain)) {
      continue;
    }
    // The most-declared spelling, so `www.` is kept when declared that way.
    const counts = new Map<string, number>();
    for (const host of hosts) counts.set(host, (counts.get(host) ?? 0) + 1);
    const host = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    return {
      tier: "B",
      host,
      domain,
      reasons: ["declared-website", `endpoint-under:${endpointHost}`],
    };
  }
  return {
    tier: "C",
    declaredDomains: [...declared.keys()].sort(),
    reasons: ["declared-website-without-control-evidence"],
  };
}
