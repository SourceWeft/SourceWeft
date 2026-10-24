/**
 * Same-product grouping of catalog MCP servers (Issue #367, W8).
 *
 * A server whose publisher also runs its endpoint (W2's
 * `publisher.endpointMatch`) defines a product group, keyed by the publisher
 * domain; it is the group's pinned official member. Third-party integrations
 * of that product join the group when their display name or identifier tail
 * carries the product's brand token as a whole token, when they share the
 * official server's repository owner, or when they are published under the
 * same domain. Everything here is deterministic and pure: no model, no
 * network, no clock.
 */

/** What grouping needs to know about one catalog server. */
export type ProductGroupEntry = {
  id: string;
  identifier: string;
  name: string;
  repoUrl: string | null;
  publishedAt: Date | null;
  publisher: ProductPublisher | null;
};

/** The publisher fields grouping reads (W2's `publisher`, read tolerantly). */
export type ProductPublisher = {
  domain: string;
  endpointMatch: boolean;
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
 * Second-level labels under which the registrable name sits one label deeper:
 * `example.co.uk`, `acme.com.au`. Short public suffixes only; a product's own
 * label is rarely this short.
 */
const SECOND_LEVEL_SUFFIX_MAX_LENGTH = 3;

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
 * The tokens a server is matched on: its display name and its identifier
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
    labels.length >= 3 && secondLevel.length <= SECOND_LEVEL_SUFFIX_MAX_LENGTH
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

/**
 * W2's `publisher` as stored on a server's metadata or a manifest, read
 * without the contract so that rows from before the field existed, and rows
 * written before W2 ships, read as "no publisher".
 */
export function publisherOf(source: unknown): ProductPublisher | null {
  if (!source || typeof source !== "object") {
    return null;
  }
  const publisher = (source as { publisher?: unknown }).publisher;
  if (!publisher || typeof publisher !== "object") {
    return null;
  }
  const { domain, endpointMatch } = publisher as {
    domain?: unknown;
    endpointMatch?: unknown;
  };
  if (typeof domain !== "string" || !/^[a-z\d.-]+\.[a-z]{2,}$/i.test(domain)) {
    return null;
  }
  return {
    domain: domain.toLowerCase(),
    endpointMatch: endpointMatch === true,
  };
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

function containsSequence(
  haystack: readonly string[],
  needle: readonly string[],
) {
  if (needle.length === 0 || needle.length > haystack.length) {
    return false;
  }
  outer: for (
    let start = 0;
    start + needle.length <= haystack.length;
    start++
  ) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

/** Whether a server's name or identifier tail carries the brand as whole tokens. */
export function entryCarriesBrand(
  group: Pick<ProductGroupKey, "brandTokens">,
  entry: { name: string; identifier: string },
): boolean {
  return (
    containsSequence(slugTokens(entry.name), group.brandTokens) ||
    containsSequence(
      slugTokens(identifierTail(entry.identifier)),
      group.brandTokens,
    )
  );
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
 * Whether a server belongs to a group: it is the official server, is published
 * under the group's domain, carries the brand in its name or slug, or shares
 * the official server's repository owner.
 */
export function isProductGroupMember(
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
 * The group a server belongs to, given the catalog's official servers. An
 * official server's own group comes first; otherwise the most specific group
 * that admits the server: one published under the same domain, then the
 * longest brand, then the first domain alphabetically — so a slug that names
 * two products lands in one group, the same one every time.
 */
export function productGroupFor(
  entry: ProductGroupEntry,
  officials: readonly ProductGroupEntry[],
): ProductGroupKey | null {
  const groups = productGroupsOf(officials);
  const own = groups.find(
    (group) => group.officialIdentifier === entry.identifier,
  );
  if (own) {
    return own;
  }
  if (isOfficialEntry(entry) && entry.publisher) {
    const sameDomain = groups.find(
      (group) => group.domain === entry.publisher!.domain,
    );
    if (sameDomain) {
      return sameDomain;
    }
  }
  const candidates = groups
    .filter((group) => isProductGroupMember(group, entry))
    .sort((left, right) => {
      const leftDomain = entry.publisher?.domain === left.domain ? 0 : 1;
      const rightDomain = entry.publisher?.domain === right.domain ? 0 : 1;
      if (leftDomain !== rightDomain) {
        return leftDomain - rightDomain;
      }
      if (left.brand.length !== right.brand.length) {
        return right.brand.length - left.brand.length;
      }
      return left.domain < right.domain
        ? -1
        : left.domain > right.domain
          ? 1
          : 0;
    });
  return candidates[0] ?? null;
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
