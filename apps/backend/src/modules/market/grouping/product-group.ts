/**
 * Same-product grouping of catalog MCP servers (Issue #367, W8).
 *
 * A server whose publisher also runs its endpoint (W2's
 * `publisher.endpointMatch`) defines a product group, keyed by the publisher
 * domain; it is the group's pinned official member. Third-party integrations
 * of that product join the group when their display name or identifier tail
 * carries the product's brand token as a whole token, when they share the
 * official server's repository owner, or when they are published under the
 * same domain. Every server belongs to at most one group, chosen by
 * `productGroupFor`; a group's members are exactly the servers that choose
 * it. Everything here is deterministic and pure: no model, no network, no
 * clock.
 */
import type { MarketMcpPublisher } from "@sourceweft/market-contracts";

/** What grouping needs to know about one catalog server. */
export type ProductGroupEntry = {
  id: string;
  identifier: string;
  name: string;
  repoUrl: string | null;
  publishedAt: Date | null;
  publisher: MarketMcpPublisher | null;
};

/** A product group: the brand and the official server that anchors it. */
export type ProductGroupKey = {
  /** The publisher domain, `notion.com`. */
  domain: string;
  /** The brand as it appears in slugs, `notion` or `claw-link`. */
  brand: string;
  /** `brand` split into the slug tokens a member must carry in sequence. */
  brandTokens: readonly string[];
  officialIdentifier: string;
  /** The official server's declared GitHub repository owner, lowercase. */
  repoOwner: string | null;
};

/** A brand must be at least this long (hyphens left out) to key a group. */
export const MIN_BRAND_LENGTH = 4;

/**
 * Registrable labels that name no product. A namespace like `ai.mcp` or
 * `cloud.tools` would otherwise group every server whose slug says "mcp".
 */
export const BRAND_STOP_LIST: ReadonlySet<string> = new Set([
  "mcp",
  "server",
  "servers",
  "api",
  "apis",
  "tool",
  "tools",
  "cloud",
  "app",
  "apps",
  "agent",
  "agents",
  "labs",
  "data",
  "open",
  "code",
  "web",
  "service",
  "services",
  "platform",
  "connect",
  "online",
  "github",
  "google",
  "remote",
  "local",
  "test",
  "example",
]);

/**
 * Second-level labels under which the registrable name sits one label deeper
 * (`example.co.uk`, `acme.com.au`, `uni.ac.jp`). A short, explicit list: a
 * length rule would read `docs.ibm.com` as the brand "docs".
 */
const SECOND_LEVEL_PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  "co",
  "com",
  "net",
  "org",
  "gov",
  "edu",
  "ac",
  "or",
  "ne",
]);

/**
 * The slug tokens of a name or identifier tail: lowercase runs of letters and
 * digits, split at every other character and at camelCase boundaries.
 * "Notion MCP Server" → notion, mcp, server; "better-notion" → better,
 * notion; "NotionMCP" → notion, mcp; "notionally" → notionally.
 */
export function slugTokens(text: string): string[] {
  return text
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The part of a reverse-DNS identifier after its namespace. */
export function identifierTail(identifier: string): string {
  const slash = identifier.indexOf("/");
  return slash < 0 ? "" : identifier.slice(slash + 1);
}

/**
 * The tokens a server is matched on: its display name, then its identifier
 * tail. The summary is left out on purpose: a server that merely mentions a
 * product ("syncs with Notion, Slack and Jira") is not an integration of it.
 */
export function entryTokens(entry: {
  name: string;
  identifier: string;
}): string[] {
  return [
    ...slugTokens(entry.name),
    ...slugTokens(identifierTail(entry.identifier)),
  ];
}

/**
 * The brand a publisher domain names: its registrable label, `notion` for
 * `notion.com` and `mcp.notion.com`, `acme` for `acme.co.uk`. Null when the
 * label is too short, on the stop-list, or the domain is malformed.
 */
export function brandOfDomain(domain: string): string | null {
  const labels = domain
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .split(".")
    .filter(Boolean);
  if (labels.length < 2) {
    return null;
  }
  const secondLevel = labels[labels.length - 2]!;
  const label =
    labels.length >= 3 && SECOND_LEVEL_PUBLIC_SUFFIXES.has(secondLevel)
      ? labels[labels.length - 3]!
      : secondLevel;
  if (!/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/.test(label)) {
    return null;
  }
  if (label.replaceAll("-", "").length < MIN_BRAND_LENGTH) {
    return null;
  }
  if (BRAND_STOP_LIST.has(label)) {
    return null;
  }
  return label;
}

/** The owner of a github.com repository URL, lowercase; null otherwise. */
export function githubRepoOwner(
  repoUrl: string | null | undefined,
): string | null {
  if (!repoUrl) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    return null;
  }
  const owner = url.pathname.split("/").filter(Boolean)[0];
  return owner ? owner.toLowerCase() : null;
}

/** The GitHub account an `io.github.<owner>/…` identifier names, lowercase. */
export function namespaceGithubOwner(identifier: string): string | null {
  const match = /^io\.github\.([^/]+)\//i.exec(identifier);
  return match ? match[1]!.toLowerCase() : null;
}

/** Whether a server is a product's official one: its publisher runs the endpoint. */
export function isOfficialEntry(entry: Pick<ProductGroupEntry, "publisher">) {
  return entry.publisher?.endpointMatch === true;
}

/**
 * The group an official server defines; null when it is not official or its
 * domain names no usable brand.
 */
export function productGroupOf(
  official: Pick<ProductGroupEntry, "identifier" | "repoUrl" | "publisher">,
): ProductGroupKey | null {
  if (!isOfficialEntry(official) || !official.publisher) {
    return null;
  }
  const brand = brandOfDomain(official.publisher.domain);
  if (!brand) {
    return null;
  }
  return {
    domain: official.publisher.domain,
    brand,
    brandTokens: slugTokens(brand),
    officialIdentifier: official.identifier,
    repoOwner: githubRepoOwner(official.repoUrl),
  };
}

/** The index at which `needle` last occurs in `haystack` as a run; -1 when never. */
function lastSequenceIndex(
  haystack: readonly string[],
  needle: readonly string[],
): number {
  if (needle.length === 0 || needle.length > haystack.length) {
    return -1;
  }
  outer: for (
    let start = haystack.length - needle.length;
    start >= 0;
    start--
  ) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) {
        continue outer;
      }
    }
    return start;
  }
  return -1;
}

/**
 * Where a server's name and identifier tail last carry the brand as whole
 * tokens, as an index into `entryTokens`; -1 when they do not. The name and
 * the tail are searched on their own, so a run never straddles the two. The
 * last mention is the head of a compound slug ("smithery-notion",
 * "better-notion" name Notion), which is what `productGroupFor` prefers.
 */
export function brandPosition(
  group: Pick<ProductGroupKey, "brandTokens">,
  entry: { name: string; identifier: string },
): number {
  const nameTokens = slugTokens(entry.name);
  const inTail = lastSequenceIndex(
    slugTokens(identifierTail(entry.identifier)),
    group.brandTokens,
  );
  if (inTail >= 0) {
    return nameTokens.length + inTail;
  }
  return lastSequenceIndex(nameTokens, group.brandTokens);
}

/** Whether a server's name or identifier tail carries the brand as whole tokens. */
export function entryCarriesBrand(
  group: Pick<ProductGroupKey, "brandTokens">,
  entry: { name: string; identifier: string },
): boolean {
  return brandPosition(group, entry) >= 0;
}

/**
 * The GitHub owners a server belongs to: its `io.github.<owner>` namespace
 * account and its declared repository's owner, when it has them.
 */
export function entryGithubOwners(
  entry: Pick<ProductGroupEntry, "identifier" | "repoUrl">,
): string[] {
  return [
    namespaceGithubOwner(entry.identifier),
    githubRepoOwner(entry.repoUrl),
  ].filter((owner): owner is string => owner !== null);
}

/**
 * Whether a group admits a server: it is the official server, is published
 * under the group's domain, carries the brand in its name or slug, or shares
 * the official server's repository owner. A server several groups admit
 * belongs to the one `productGroupFor` picks.
 */
export function groupAdmits(
  group: ProductGroupKey,
  entry: Pick<
    ProductGroupEntry,
    "identifier" | "name" | "repoUrl" | "publisher"
  >,
): boolean {
  if (entry.identifier === group.officialIdentifier) {
    return true;
  }
  if (entry.publisher?.domain === group.domain) {
    return true;
  }
  if (entryCarriesBrand(group, entry)) {
    return true;
  }
  return (
    group.repoOwner !== null &&
    entryGithubOwners(entry).includes(group.repoOwner)
  );
}

/**
 * The first official server per domain in publication order: when a publisher
 * runs two servers on its domain, the older one anchors the group and the
 * other is a member marked official too.
 */
export function productGroupsOf(
  officials: readonly ProductGroupEntry[],
): ProductGroupKey[] {
  const sorted = [...officials].sort(compareByPublication);
  const byDomain = new Map<string, ProductGroupKey>();
  for (const official of sorted) {
    const group = productGroupOf(official);
    if (group && !byDomain.has(group.domain)) {
      byDomain.set(group.domain, group);
    }
  }
  return [...byDomain.values()];
}

/**
 * How closely a group fits a server, lower is closer: the official server's
 * own group or one on its publisher domain (0); a brand the server's name or
 * slug carries (1), later mentions first — the head of a compound slug names
 * the product, so "smithery-notion" is a Notion integration hosted on
 * Smithery, not a Smithery one; a server published under the group's domain
 * (2); a shared repository owner (3). Ties go to the longer brand, then the
 * first domain alphabetically.
 */
function fitOf(
  group: ProductGroupKey,
  entry: ProductGroupEntry,
): readonly [tier: number, position: number] {
  if (
    entry.identifier === group.officialIdentifier ||
    (isOfficialEntry(entry) && entry.publisher?.domain === group.domain)
  ) {
    return [0, 0];
  }
  const position = brandPosition(group, entry);
  if (position >= 0) {
    return [1, -position];
  }
  if (entry.publisher?.domain === group.domain) {
    return [2, 0];
  }
  return [3, 0];
}

/**
 * The one group a server belongs to, given the catalog's official servers:
 * the closest fit among the groups that admit it (see `fitOf`), the same one
 * every time. Null when no group admits it.
 */
export function productGroupFor(
  entry: ProductGroupEntry,
  officials: readonly ProductGroupEntry[],
): ProductGroupKey | null {
  const candidates = productGroupsOf(officials)
    .filter((group) => groupAdmits(group, entry))
    .map((group) => ({ group, fit: fitOf(group, entry) }))
    .sort((left, right) => {
      if (left.fit[0] !== right.fit[0]) {
        return left.fit[0] - right.fit[0];
      }
      if (left.fit[1] !== right.fit[1]) {
        return left.fit[1] - right.fit[1];
      }
      if (left.group.brand.length !== right.group.brand.length) {
        return right.group.brand.length - left.group.brand.length;
      }
      return left.group.domain < right.group.domain
        ? -1
        : left.group.domain > right.group.domain
          ? 1
          : 0;
    });
  return candidates[0]?.group ?? null;
}

/**
 * Whether a server is a member of `group`: the group is the one it belongs
 * to. The list a detail page shows and the group each member's own page
 * names are the same relation.
 */
export function isProductGroupMember(
  group: Pick<ProductGroupKey, "domain">,
  entry: ProductGroupEntry,
  officials: readonly ProductGroupEntry[],
): boolean {
  return productGroupFor(entry, officials)?.domain === group.domain;
}

/** Oldest publication first; unpublished last; identifier breaks ties. */
function compareByPublication(
  left: ProductGroupEntry,
  right: ProductGroupEntry,
) {
  const leftTime = left.publishedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const rightTime = right.publishedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return left.identifier < right.identifier
    ? -1
    : left.identifier > right.identifier
      ? 1
      : 0;
}

/**
 * Group members in display order: the official server first, any other
 * server marked official next, then the catalog's own browse order (newest
 * publication first, id breaking ties).
 */
export function compareProductGroupMembers(
  group: Pick<ProductGroupKey, "officialIdentifier">,
) {
  return (left: ProductGroupEntry, right: ProductGroupEntry) => {
    const leftPinned = left.identifier === group.officialIdentifier ? 0 : 1;
    const rightPinned = right.identifier === group.officialIdentifier ? 0 : 1;
    if (leftPinned !== rightPinned) {
      return leftPinned - rightPinned;
    }
    const leftOfficial = isOfficialEntry(left) ? 0 : 1;
    const rightOfficial = isOfficialEntry(right) ? 0 : 1;
    if (leftOfficial !== rightOfficial) {
      return leftOfficial - rightOfficial;
    }
    const leftTime = left.publishedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    const rightTime = right.publishedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (leftTime !== rightTime) {
      return rightTime - leftTime;
    }
    return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
  };
}
