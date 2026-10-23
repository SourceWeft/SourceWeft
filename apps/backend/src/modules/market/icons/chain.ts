import type { MarketMcpIconSource } from "@sourceweft/market-contracts";

/**
 * The logo chain of a federated MCP entry (Issue #367, W3). First hit wins and
 * the source is recorded as the manifest's `iconSource`:
 *
 * 1. the registry's own `icons`                      → `registry`
 * 2. the server's `initialize` answer, `serverInfo.icons`
 *    (provenance `selfDescription`, written by W1)   → `server-info`
 * 3. a GitHub avatar: the owner of `io.github.<owner>`, else the owner of the
 *    declared repository when it is on github.com   → `github-avatar`;
 *    else the GitHub MCP Registry's owner avatar
 *    (provenance `githubRegistry`, written by W5)    → `github-registry`
 * 4. the namespace domain's favicon, fetched at sync and served from our own
 *    storage (`favicon.ts`, `store.ts`)              → `favicon`
 * 5. nothing                                          → `placeholder`
 *
 * Everything here is pure: the sync step (`registry-icons.ts`) runs steps 1–3
 * with `iconBeforeFavicon`, fetches a favicon only when they found nothing,
 * and finishes with `resolveIcon`.
 */

export type ResolvedIcon = {
  iconUrl?: string;
  iconSource: MarketMcpIconSource;
};

export type IconChainInput = {
  /** The reverse-DNS namespace, e.g. `com.notion` or `io.github.acme`. */
  namespace: string;
  /** The first valid https icon the registry entry declares. */
  registryIconUrl?: string;
  /** `serverInfo.icons` from the server's own `initialize` answer; any shape. */
  serverInfoIcons?: unknown;
  /** The registry entry's declared `repository.url`. */
  repositoryUrl?: string;
  /** The GitHub MCP Registry's `ownerAvatarUrl` for the matched entry. */
  githubRegistryAvatarUrl?: unknown;
};

// GitHub login rules: 1–39 alphanumerics or hyphens, no leading, trailing or
// doubled hyphen.
const GITHUB_OWNER_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
// A DNS label: 1–63 alphanumerics or hyphens, neither leading nor trailing.
const DNS_LABEL_RE = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/;

/** Hosts a GitHub avatar may be served from. */
export const GITHUB_AVATAR_HOSTS: readonly string[] = [
  "github.com",
  "avatars.githubusercontent.com",
];

/** The namespace labels, lowercased; [] when the namespace is not reverse-DNS. */
function namespaceLabels(namespace: string) {
  const labels = namespace.trim().toLowerCase().split(".");
  return labels.length >= 2 && labels.every((label) => DNS_LABEL_RE.test(label))
    ? labels
    : [];
}

export function isGithubNamespace(namespace: string) {
  const labels = namespaceLabels(namespace);
  return labels[0] === "io" && labels[1] === "github";
}

/**
 * The domain a reverse-DNS namespace names (`com.notion` → `notion.com`), or
 * undefined for `io.github.*` (a GitHub account, not a domain publisher) and
 * for anything that is not reverse-DNS. It is the NAMESPACE's domain: the
 * endpoint host is often a hosting provider and is never used.
 */
export function namespaceDomain(namespace: string): string | undefined {
  const labels = namespaceLabels(namespace);
  if (labels.length === 0 || isGithubNamespace(namespace)) return undefined;
  return labels.reverse().join(".");
}

/**
 * The GitHub owner whose avatar stands for the entry: the owner of an
 * `io.github.<owner>` namespace, else the owner of a declared github.com
 * repository. Undefined when neither names one.
 */
export function githubOwner(input: {
  namespace: string;
  repositoryUrl?: string | null;
}): string | undefined {
  const labels = namespaceLabels(input.namespace);
  if (isGithubNamespace(input.namespace)) {
    // The registry keeps the owner's own casing in the name; use it as given.
    const owner = input.namespace.trim().split(".")[2];
    if (owner && labels.length === 3 && GITHUB_OWNER_RE.test(owner)) {
      return owner;
    }
  }
  if (!input.repositoryUrl) return undefined;
  try {
    const url = new URL(input.repositoryUrl);
    if (url.protocol !== "https:" || url.hostname !== "github.com") {
      return undefined;
    }
    const owner = url.pathname.split("/").filter(Boolean)[0];
    return owner && GITHUB_OWNER_RE.test(owner) ? owner : undefined;
  } catch {
    return undefined;
  }
}

/** GitHub's own avatar URL for `owner`; github.com redirects it to its CDN. */
export function githubAvatarUrl(owner: string) {
  return `https://github.com/${encodeURIComponent(owner)}.png?size=128`;
}

/**
 * The first usable `src` in an MCP `icons` array (the registry's and
 * `serverInfo.icons` share the shape `{ src, mimeType?, sizes?, theme? }`):
 * an absolute https URL without credentials. Anything else is skipped.
 */
export function firstHttpsIconSrc(icons: unknown): string | undefined {
  if (!Array.isArray(icons)) return undefined;
  for (const icon of icons) {
    if (!icon || typeof icon !== "object") continue;
    const src = (icon as { src?: unknown }).src;
    if (typeof src !== "string") continue;
    try {
      const url = new URL(src);
      if (url.protocol === "https:" && !url.username && !url.password) {
        return url.toString();
      }
    } catch {
      // Malformed upstream entry; try the next one.
    }
  }
  return undefined;
}

/** `ownerAvatarUrl` as the GitHub MCP Registry gives it, when it is GitHub's. */
function githubRegistryAvatar(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      GITHUB_AVATAR_HOSTS.includes(url.hostname)
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/** Steps 1–3: everything that needs no fetch. Undefined when they all miss. */
export function iconBeforeFavicon(
  input: IconChainInput,
): ResolvedIcon | undefined {
  if (input.registryIconUrl) {
    return { iconUrl: input.registryIconUrl, iconSource: "registry" };
  }
  const serverInfo = firstHttpsIconSrc(input.serverInfoIcons);
  if (serverInfo) {
    return { iconUrl: serverInfo, iconSource: "server-info" };
  }
  const owner = githubOwner(input);
  if (owner) {
    return { iconUrl: githubAvatarUrl(owner), iconSource: "github-avatar" };
  }
  const registryAvatar = githubRegistryAvatar(input.githubRegistryAvatarUrl);
  if (registryAvatar) {
    return { iconUrl: registryAvatar, iconSource: "github-registry" };
  }
  return undefined;
}

/**
 * The whole chain: steps 1–3, then `faviconUrl` (our stored copy of the
 * namespace domain's favicon, when the sync fetched one), then the
 * placeholder.
 */
export function resolveIcon(
  input: IconChainInput,
  faviconUrl?: string,
): ResolvedIcon {
  return (
    iconBeforeFavicon(input) ??
    (faviconUrl
      ? { iconUrl: faviconUrl, iconSource: "favicon" }
      : { iconSource: "placeholder" })
  );
}
