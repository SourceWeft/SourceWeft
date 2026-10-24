import {
  MARKET_MCP_INSPECT_LIMITS,
  type MarketMcpInspectedTool,
} from "@sourceweft/market-contracts";
import { isRecord } from "./jsonrpc";

/**
 * Cuts what a server listed down to what the inspect file may hold. The
 * contract bounds every field; a server is third-party, so an oversize or
 * oddly typed value is dropped or shortened rather than refused.
 */

/** Longest value kept under a `serverInfo` key. */
const SERVER_INFO_VALUE_CHARS = 1_000;

function cutDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const limit = MARKET_MCP_INSPECT_LIMITS.descriptionChars;
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

function fitsSchemaBytes(value: Record<string, unknown>): boolean {
  return (
    Buffer.byteLength(JSON.stringify(value)) <=
    MARKET_MCP_INSPECT_LIMITS.schemaBytes
  );
}

/** One listed tool as the file holds it, or null when it has no usable name. */
export function boundInspectedTool(raw: unknown): MarketMcpInspectedTool | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.name !== "string" || raw.name.length === 0) return null;
  const tool: MarketMcpInspectedTool = {
    name: raw.name.slice(0, MARKET_MCP_INSPECT_LIMITS.nameChars),
    inputSchema:
      isRecord(raw.inputSchema) && fitsSchemaBytes(raw.inputSchema)
        ? raw.inputSchema
        : {},
    annotations: isRecord(raw.annotations) ? raw.annotations : {},
  };
  if (typeof raw.title === "string") {
    tool.title = raw.title.slice(0, MARKET_MCP_INSPECT_LIMITS.titleChars);
  }
  const description = cutDescription(raw.description);
  if (description !== undefined) tool.description = description;
  if (isRecord(raw.outputSchema) && fitsSchemaBytes(raw.outputSchema)) {
    tool.outputSchema = raw.outputSchema;
  }
  return tool;
}

/**
 * Every tool bounded, deduplicated by name (the first listing wins) and capped
 * at the contract's count. `truncated` says the cap dropped some.
 */
export function boundInspectedTools(raw: readonly unknown[]): {
  tools: MarketMcpInspectedTool[];
  truncated: boolean;
} {
  const tools: MarketMcpInspectedTool[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const item of raw) {
    const tool = boundInspectedTool(item);
    if (!tool || seen.has(tool.name)) continue;
    if (tools.length >= MARKET_MCP_INSPECT_LIMITS.tools) {
      truncated = true;
      break;
    }
    seen.add(tool.name);
    tools.push(tool);
  }
  return { tools, truncated };
}

/**
 * The endpoint as the file records it: the origin only. Hosted MCP servers
 * put per-user secrets in the path (`/api/mcp/s/<secret>/mcp`), and the
 * query string, fragment and userinfo may carry a key; none of it is written.
 */
export function reduceTargetUrl(input: string): string {
  return new URL(input).origin;
}

/**
 * The server's self-description from `initialize`, when it is an object, with
 * any key whose value runs long dropped: a name and a version are short.
 */
export function boundServerInfo(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const kept: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const length =
      typeof item === "string"
        ? item.length
        : (JSON.stringify(item) ?? "").length;
    if (length <= SERVER_INFO_VALUE_CHARS) kept[key] = item;
  }
  return kept;
}
