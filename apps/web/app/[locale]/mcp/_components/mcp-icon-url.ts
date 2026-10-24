import type { MarketMcpIconSource } from "@sourceweft/market-sdk";

/**
 * Hosts a GitHub avatar is served from: `github.com/<owner>.png` and the CDN
 * it redirects to. An icon the catalog labels as a GitHub avatar is rendered
 * only from one of these.
 */
export const MCP_ICON_TRUSTED_HOSTS: readonly string[] = [
  "github.com",
  "avatars.githubusercontent.com",
];

const AVATAR_SOURCES: ReadonlySet<MarketMcpIconSource> = new Set([
  "github-avatar",
  "github-registry",
]);

/**
 * The icon URL an `<img>` may be given, or null. Any source needs an https
 * URL without credentials; a GitHub-avatar source must also be on one of the
 * trusted hosts. Registry, server-info and stored-favicon icons come from
 * their publisher's or our own https host and pass as they are.
 */
export function safeMcpIconUrl(
  value: string | null | undefined,
  source?: MarketMcpIconSource | null,
) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) {
      return null;
    }
    if (source && AVATAR_SOURCES.has(source)) {
      return MCP_ICON_TRUSTED_HOSTS.includes(url.hostname)
        ? url.toString()
        : null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * The letter a placeholder shows for `name`: its first letter or digit,
 * uppercased, in whatever script; null when it has none.
 */
export function mcpIconMonogram(name: string | null | undefined) {
  const match = (name ?? "").trim().match(/[\p{L}\p{N}]/u);
  return match ? match[0]!.toLocaleUpperCase() : null;
}
