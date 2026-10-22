import type { McpRuntime, McpTransport } from "@sourceweft/market-contracts";

export type McpRuntimeKind = "hybrid" | "desktop" | "web";

/**
 * Where an MCP server can run. Keys the localized `mcp.badges.runtime`
 * labels and the English {@link runtimeLabel}.
 */
export function mcpRuntimeKind(item: {
  desktopOnly?: boolean;
  runtime?: McpRuntime;
  webExecutable?: boolean;
}): McpRuntimeKind {
  if (item.runtime === "hybrid") return "hybrid";
  if (item.runtime === "desktop" || item.desktopOnly || !item.webExecutable) {
    return "desktop";
  }
  return "web";
}

const RUNTIME_LABELS: Record<McpRuntimeKind, string> = {
  hybrid: "Web + Desktop",
  desktop: "Desktop only",
  web: "Web executable",
};

export function runtimeLabel(item: {
  desktopOnly?: boolean;
  runtime?: McpRuntime;
  webExecutable?: boolean;
}) {
  return RUNTIME_LABELS[mcpRuntimeKind(item)];
}

/** Protocol names read the same in every locale, so these stay untranslated. */
export function transportLabel(transport?: McpTransport | null) {
  if (transport === "streamable_http") {
    return "Streamable HTTP";
  }
  if (transport === "http_sse_compat") {
    return "HTTP/SSE";
  }
  if (transport === "sse") {
    return "SSE";
  }
  if (transport === "stdio") {
    return "STDIO";
  }
  return "MCP";
}
