// Free of server-only imports, so client components can build the same paths
// as the server pages.

export function mcpPath(identifier: string) {
  return `/mcp/${encodeURIComponent(identifier)}`;
}

/**
 * The server's connect guide for AI agents: one English Markdown file outside
 * the locale prefix, so it is linked and fetched as it is, never rewritten.
 */
export function mcpInstallGuidePath(identifier: string) {
  return `${mcpPath(identifier)}/install.md`;
}
