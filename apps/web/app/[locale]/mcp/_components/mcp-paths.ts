// Free of server-only imports, so client components can build the same paths
// as the server pages.

export function mcpPath(identifier: string) {
  return `/mcp/${encodeURIComponent(identifier)}`;
}
