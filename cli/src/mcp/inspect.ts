import { MARKET_MCP_INSPECT_LIMITS } from "@sourceweft/market-contracts";
import { McpInspectError } from "../errors";
import { isRecord, type McpTransport } from "./jsonrpc";

/** The protocol version this client speaks; servers answer with theirs. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
/** `tools/list` pages followed for one server. */
export const MAX_TOOL_PAGES = 10;

export type InspectResult = {
  protocolVersion?: string;
  serverInfo?: unknown;
  /** As listed, unbounded; `boundInspectedTools` cuts them to the contract. */
  tools: unknown[];
  /** The server had more tools than the contract holds, or more pages than are read. */
  truncated: boolean;
};

/**
 * The MCP handshake over any transport: `initialize`, the `initialized`
 * notification, then `tools/list` page by page until the server has no more,
 * the page limit is reached or the contract's tool count is full. The
 * transport is closed on every path out.
 */
export async function inspectServer(
  transport: McpTransport,
  client: { name: string; version: string },
): Promise<InspectResult> {
  try {
    const initialized = await transport.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: client,
    });
    if (!isRecord(initialized)) {
      throw new McpInspectError(
        "The server answered initialize without a result object.",
      );
    }
    await transport.notify("notifications/initialized");

    const tools: unknown[] = [];
    let truncated = false;
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = await transport.request(
        "tools/list",
        cursor === undefined ? {} : { cursor },
      );
      if (!isRecord(result) || !Array.isArray(result.tools)) {
        throw new McpInspectError(
          "The server answered tools/list without a tools array.",
        );
      }
      for (const tool of result.tools) {
        if (tools.length < MARKET_MCP_INSPECT_LIMITS.tools) tools.push(tool);
        else truncated = true;
      }
      const next =
        typeof result.nextCursor === "string" && result.nextCursor
          ? result.nextCursor
          : undefined;
      if (next === undefined) break;
      if (tools.length >= MARKET_MCP_INSPECT_LIMITS.tools) {
        truncated = true;
        break;
      }
      cursor = next;
      if (page === MAX_TOOL_PAGES - 1) truncated = true;
    }

    return {
      ...(typeof initialized.protocolVersion === "string"
        ? { protocolVersion: initialized.protocolVersion }
        : {}),
      serverInfo: initialized.serverInfo,
      tools,
      truncated,
    };
  } finally {
    await transport.close();
  }
}
