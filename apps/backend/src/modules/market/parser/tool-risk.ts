import type { McpRiskLevel } from "@sourceweft/market-contracts";

/**
 * A tool's risk level from what its name says it does: delete-like names are
 * destructive, create/update-like names write, get/list-like names read.
 */
export function classifyToolRiskByName(name: string): McpRiskLevel {
  const lower = name.toLowerCase();
  if (/(delete|destroy|remove|drop|purge|reset|revoke)/.test(lower)) {
    return "destructive";
  }
  if (
    /(create|update|write|edit|merge|close|open|send|post|put|patch)/.test(
      lower,
    )
  ) {
    return "write";
  }
  if (/(get|list|read|search|fetch|find|query|lookup)/.test(lower)) {
    return "read";
  }
  return "unknown";
}

/**
 * A tool's risk level from the MCP annotations its server declares, falling
 * back to its name: `readOnlyHint` reads, `destructiveHint` destroys, a tool
 * declared neither read-only nor destructive writes. Hints are the server's
 * own word, so they are advisory, as the catalog labels every risk level.
 */
export function classifyToolRisk(
  name: string,
  annotations: Record<string, unknown> | undefined,
): McpRiskLevel {
  if (annotations?.readOnlyHint === true) return "read";
  if (annotations?.destructiveHint === true) return "destructive";
  if (
    annotations?.readOnlyHint === false ||
    annotations?.destructiveHint === false
  ) {
    return "write";
  }
  return classifyToolRiskByName(name);
}
