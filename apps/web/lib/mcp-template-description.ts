import type { McpTransport } from "@sourceweft/market-contracts";

import type { McpAuthMethod } from "./mcp-auth-method";
import { transportLabel } from "./mcp-labels";

/**
 * The deterministic description of an MCP server that has no AI overview
 * (#367 W4): one localized sentence built only from facts, for example
 * "Notion's hosted MCP server (mcp.notion.com), published by notion.com;
 * OAuth sign-in required; Streamable HTTP; 24 tools." Nothing in it is
 * inferred — an unknown transport gets "{name}'s MCP server", not a guess
 * at where it runs — so it can stand where an overview would without
 * inventing text.
 */

export type McpTemplateFacts = {
  name: string;
  /** The publisher's domain (W2), when the entry has one. */
  publisherDomain?: string | null;
  /** The remote endpoint's host, when known (not on list items). */
  endpointHost?: string | null;
  transport?: McpTransport | null;
  /** The `mcp.authMethod` key the server's auth maps to. */
  authMethod: McpAuthMethod;
  /** Listed when above zero. */
  toolCount?: number | null;
};

/** A translator for the `mcp.template` messages. */
export type McpTemplateTranslator = (
  key: string,
  values?: Record<string, string | number>,
) => string;

// Registry names often end in "MCP Server" ("GitHub MCP Server"), and the lead
// sentence already says "MCP server".
const MCP_NAME_SUFFIX = /[\s\-–—:|]*\bMCP(?:\s+server)?$/i;

/** The name for the lead sentence: without a trailing "MCP"/"MCP Server". */
function leadName(name: string): string {
  return name.replace(MCP_NAME_SUFFIX, "").trim() || name;
}

export function mcpTemplateDescription(
  facts: McpTemplateFacts,
  t: McpTemplateTranslator,
): string {
  const name = facts.name.trim();
  const publisher = facts.publisherDomain?.trim() || null;
  const host = facts.endpointHost?.trim() || null;
  // Where it runs is said only when the transport says so: stdio runs
  // locally, any other transport is hosted, and no transport (a list item
  // from before it was recorded) gets a neutral lead rather than a guess.
  const runs = !facts.transport
    ? "unknown"
    : facts.transport === "stdio"
      ? "local"
      : host
        ? "remote"
        : "remoteNoHost";
  const leadKey = publisher ? `${runs}ByPublisher` : runs;
  const parts = [
    t(leadKey, {
      name: leadName(name),
      publisher: publisher ?? "",
      host: host ?? "",
    }),
    t(`auth.${facts.authMethod}`),
    ...(facts.transport ? [transportLabel(facts.transport)] : []),
    ...(facts.toolCount && facts.toolCount > 0
      ? [t("tools", { count: facts.toolCount })]
      : []),
  ];
  return `${parts.join(t("separator"))}${t("end")}`;
}
