import type { MarketMcpGithubRegistryMatch } from "@sourceweft/market-contracts";
import type { GithubRegistryRow } from "./fetch";

/**
 * Which GitHub MCP Registry row describes which catalog entry. Two rules, and
 * nothing else is a match:
 *
 * (a) `name`: the row's name equals our registry identifier exactly. Most of
 *     GitHub's rows are the official registry's entries under the same
 *     reverse-DNS names.
 * (b) `endpoint-domain-org`: for the brand servers GitHub lists under
 *     `owner/repo` (`makenotion/notion-mcp-server` for our `com.notion/mcp`),
 *     all three of: the row's first remote has the same host as our endpoint;
 *     that host's registrable domain is the domain our namespace names
 *     (`com.notion` → `notion.com`); and GitHub says an organization owns the
 *     repository. The path is deliberately ignored (`/sse` against `/mcp`).
 *
 * `io.github.<owner>` namespaces name `owner.github.io`, whose registrable
 * domain is `github.io`, so they can only ever match by name.
 */

export type GithubRegistryMatchTarget = {
  identifier: string;
  endpointUrl?: string | null;
};

export type GithubRegistryMatch = {
  matchedBy: MarketMcpGithubRegistryMatch;
};

/** The lowercased host of an http(s) URL; undefined for anything else. */
export function urlHost(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    return host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Second-level labels that are public suffixes under two-letter country
 * codes (`co.uk`, `com.au`, `ac.jp`): under these the registrable domain is
 * three labels, not two.
 */
const COUNTRY_SECOND_LEVEL = new Set([
  "ac",
  "co",
  "com",
  "edu",
  "gov",
  "mil",
  "net",
  "org",
  "or",
  "ne",
  "go",
]);

/**
 * The registrable domain of a host under a conservative rule: its last two
 * labels, or three under a two-letter country code whose second-level label is
 * a public suffix itself (`example.co.uk`). The repository has no Public
 * Suffix List, and this is not one: a host under a multi-label public suffix
 * it does not know (`example.github.io`, `example.blogspot.com`) comes back as
 * the suffix (`github.io`), which can only make a match FAIL, never succeed
 * wrongly — a namespace never names such a suffix. IP literals and
 * single-label hosts have no registrable domain.
 */
export function registrableDomain(host: string): string | undefined {
  const labels = host
    .toLowerCase()
    .replace(/\.$/, "")
    .split(".")
    .filter(Boolean);
  if (labels.length < 2) return undefined;
  if (labels.every((label) => /^\d+$/.test(label))) return undefined;
  if (host.includes(":")) return undefined;
  const tld = labels[labels.length - 1]!;
  const second = labels[labels.length - 2]!;
  const take =
    labels.length >= 3 && tld.length === 2 && COUNTRY_SECOND_LEVEL.has(second)
      ? 3
      : 2;
  return labels.slice(-take).join(".");
}

/**
 * The domain a reverse-DNS namespace names: its labels reversed
 * (`com.notion` → `notion.com`, `io.github.acme` → `acme.github.io`).
 * Undefined for a namespace with fewer than two labels.
 */
export function namespaceDomain(namespace: string): string | undefined {
  const labels = namespace.toLowerCase().split(".").filter(Boolean);
  if (labels.length < 2) return undefined;
  return labels.reverse().join(".");
}

/** The namespace part of a registry identifier (`com.notion/mcp` → `com.notion`). */
export function identifierNamespace(identifier: string): string {
  return identifier.split("/")[0] ?? identifier;
}

/** How `row` matches `target`, or null when it does not. */
export function matchGithubRegistryRow(
  row: GithubRegistryRow,
  target: GithubRegistryMatchTarget,
): GithubRegistryMatch | null {
  if (row.name === target.identifier) {
    return { matchedBy: "name" };
  }
  if (!row.github.isInOrganization) return null;
  const rowHost = urlHost(row.remoteUrl);
  const ourHost = urlHost(target.endpointUrl);
  if (!rowHost || !ourHost || rowHost !== ourHost) return null;
  const domain = registrableDomain(rowHost);
  const expected = namespaceDomain(identifierNamespace(target.identifier));
  if (!domain || !expected || domain !== expected) return null;
  return { matchedBy: "endpoint-domain-org" };
}
