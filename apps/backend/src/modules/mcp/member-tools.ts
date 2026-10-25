import type { DynamicStructuredTool } from "@langchain/core/tools";
import type { DiscoverWorkspaceMcpToolsResponse } from "@sourceweft/contracts";

/** Limits on what one member's discovery may return, whatever the server lists. */
export const MEMBER_DISCOVERY_MAX_TOOLS = 200;
export const MEMBER_DISCOVERY_MAX_TOOL_BYTES = 32 * 1024;
const MEMBER_DISCOVERY_DESCRIPTION_CHARS = 500;

export type MemberToolInput = {
  name: string;
  description: string | undefined;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
};

export function memberToolInput(
  tool: DynamicStructuredTool,
  name: string,
): MemberToolInput {
  const metadata =
    tool.metadata && typeof tool.metadata === "object"
      ? (tool.metadata as Record<string, unknown>)
      : {};
  const annotations =
    metadata.annotations && typeof metadata.annotations === "object"
      ? (metadata.annotations as Record<string, unknown>)
      : {};
  const schema =
    tool.schema && typeof tool.schema === "object"
      ? (tool.schema as Record<string, unknown>)
      : {};
  return { name, description: tool.description, inputSchema: schema, annotations };
}

/**
 * Bound a member's discovered tools. At most MEMBER_DISCOVERY_MAX_TOOLS are
 * considered; one whose name, description and schema serialize past
 * MEMBER_DISCOVERY_MAX_TOOL_BYTES is left out and counted, so a hostile or
 * careless server cannot make the response (or a later observation record)
 * unbounded.
 */
export function boundMemberTools(
  tools: MemberToolInput[],
): { response: DiscoverWorkspaceMcpToolsResponse; accepted: MemberToolInput[] } {
  const considered = tools.slice(0, MEMBER_DISCOVERY_MAX_TOOLS);
  const accepted: MemberToolInput[] = [];
  let skippedOversize = 0;
  for (const tool of considered) {
    let size: number;
    try {
      size = Buffer.byteLength(
        JSON.stringify({
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema,
        }),
      );
    } catch {
      skippedOversize++;
      continue;
    }
    if (size > MEMBER_DISCOVERY_MAX_TOOL_BYTES) {
      skippedOversize++;
      continue;
    }
    accepted.push(tool);
  }
  return {
    accepted,
    response: {
      tools: accepted.map((tool) => ({
        name: tool.name,
        description: (tool.description ?? "").slice(
          0,
          MEMBER_DISCOVERY_DESCRIPTION_CHARS,
        ),
        readOnly: tool.annotations.readOnlyHint === true,
        destructive: tool.annotations.destructiveHint === true,
      })),
      toolCount: tools.length,
      truncated: tools.length > MEMBER_DISCOVERY_MAX_TOOLS,
      skippedOversize,
    },
  };
}

/**
 * Hook for tool-list observations: called with the bounded tools one member
 * just discovered through their own connection. It deliberately does nothing
 * today — nothing discovered here is written to the catalog or to the
 * install's shared tool rows. A later change may record it here, with its own
 * consent and quality rules.
 */
export async function recordMemberToolObservation(_input: {
  workspaceId: string;
  installId: string;
  userId: string;
  tools: MemberToolInput[];
}): Promise<void> {
  // Intentionally empty.
}
