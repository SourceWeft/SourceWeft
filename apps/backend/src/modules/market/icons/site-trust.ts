import { githubOwner, namespaceDomain } from "./chain";
import {
  brandLabel,
  hostIsUnder,
  registrableDomainOf,
  registrableDomainOfUrl,
} from "./site-domain";

/**
 * Which website, if any, may be read for an entry's logo (Issue #367).
 *
 * - **A** — the site is the publisher's by proof: the namespace is a domain
 *   (the registry verified its owner) and the entry's endpoint is under that
 *   domain, or a member's claim of the domain (DNS / well-known) was verified.
 *   A claim proves control of the listing and its domain; it never blesses a
 *   different homepage domain.
 * - **B** — at least two INDEPENDENT declarations name the same registrable
 *   domain, and that domain is consistent with the endpoint's domain or the
 *   declared repository. Independence is by channel: the registry file, the
 *   running endpoint (its `serverInfo` and its protected-resource metadata
 *   are one voice) and the GitHub account are three; two fields from one
 *   channel count once.
 * - **C** — a single declaration (or declarations that do not agree or are not
 *   consistent). No automatic fetch; the declared site is only reported.
 */

export type DeclarationChannel = "registry" | "endpoint" | "github";

export type SiteEvidence = {
  /** The reverse-DNS namespace of the entry. */
  namespace: string;
  endpointUrl?: string;
  /** The registry entry's declared `repository.url`. */
  repositoryUrl?: string;
  /** Registry `websiteUrl`. */
  registryWebsiteUrl?: string;
  /** `serverInfo.websiteUrl` from the endpoint's own `initialize` answer. */
  serverInfoWebsiteUrl?: string;
  /** The endpoint's protected-resource metadata `resource_documentation`. */
  resourceDocumentationUrl?: string;
  /** The declared repository's / owner's homepage on GitHub, when known. */
  githubHomepageUrl?: string;
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

const normalizeName = (value: string) => value.toLowerCase().replace(/[^a-z\d]/g, "");

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

  // A, by the namespace's domain with the endpoint under it.
  const nsDomain = namespaceDomain(evidence.namespace);
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

  // B / C, from declarations grouped by registrable domain.
  const declarations: Array<{ channel: DeclarationChannel; host: string }> = [];
  const add = (channel: DeclarationChannel, url: string | undefined) => {
    const host = hostOfUrl(url);
    if (host) declarations.push({ channel, host });
  };
  add("registry", evidence.registryWebsiteUrl);
  add("endpoint", evidence.serverInfoWebsiteUrl);
  add("endpoint", evidence.resourceDocumentationUrl);
  add("github", evidence.githubHomepageUrl);

  const byDomain = new Map<
    string,
    { channels: Set<DeclarationChannel>; hosts: Map<string, number> }
  >();
  for (const { channel, host } of declarations) {
    const domain = registrableDomainOf(host);
    if (!domain) continue;
    const group = byDomain.get(domain) ?? {
      channels: new Set(),
      hosts: new Map(),
    };
    group.channels.add(channel);
    group.hosts.set(host, (group.hosts.get(host) ?? 0) + 1);
    byDomain.set(domain, group);
  }
  if (byDomain.size === 0) {
    return { tier: "none", reasons: ["no-declared-site"] };
  }

  const endpointDomain = endpointHost
    ? registrableDomainOf(endpointHost)
    : undefined;
  const repositoryDomain = evidence.repositoryUrl
    ? registrableDomainOfUrl(evidence.repositoryUrl)
    : undefined;
  const owner = githubOwner({
    namespace: evidence.namespace,
    repositoryUrl: evidence.repositoryUrl,
  });

  for (const [domain, group] of byDomain) {
    if (group.channels.size < 2) continue;
    const consistent: string[] = [];
    if (endpointDomain === domain) consistent.push("endpoint-domain");
    if (
      repositoryDomain === domain &&
      repositoryDomain !== "github.com" &&
      repositoryDomain !== "gitlab.com"
    ) {
      consistent.push("repository-domain");
    }
    if (owner && normalizeName(owner) === normalizeName(brandLabel(domain))) {
      consistent.push("repository-owner");
    }
    if (group.channels.has("github") && evidence.repositoryUrl) {
      consistent.push("github-declaration");
    }
    if (consistent.length === 0) continue;
    // The most-declared host of the agreeing domain, so `www.` is kept when
    // both declarations spell it that way.
    const host = [...group.hosts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    return {
      tier: "B",
      host,
      domain,
      reasons: [
        `declared-by:${[...group.channels].sort().join("+")}`,
        ...consistent.map((c) => `consistent:${c}`),
      ],
    };
  }

  return {
    tier: "C",
    declaredDomains: [...byDomain.keys()].sort(),
    reasons: ["single-or-unconfirmed-declaration"],
  };
}
