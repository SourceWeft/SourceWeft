import {
  MARKET_MCP_INSPECT_LIMITS,
  MARKET_MCP_TOOL_MAX_NESTING,
  marketMcpNestsDeeperThan,
} from "@sourceweft/market-contracts";

/** What of a member's discovered tool the listing keeps (Issue #367). */

export type MemberObservedTool = {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
};

/**
 * Keywords of an input schema that carry VALUES rather than structure, and so
 * may hold the connecting account's own data (a default workspace, an example
 * row, the list of this account's projects as an enum). They are removed
 * everywhere a schema is read, never inside a name-to-schema map.
 */
const VALUE_KEYWORDS: ReadonlySet<string> = new Set([
  "default",
  "examples",
  "example",
  "const",
  "enum",
]);

/** Keywords whose value maps NAMES to schemas: the names are not keywords. */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);

// Own data properties only, so a key named `__proto__` stays a plain key.
function setOwn(target: Record<string, unknown>, key: string, value: unknown) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function structureOf(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(structureOf);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (VALUE_KEYWORDS.has(key)) continue;
    if (SCHEMA_MAP_KEYWORDS.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
      const named: Record<string, unknown> = {};
      for (const [name, entry] of Object.entries(value)) {
        setOwn(named, name, structureOf(entry));
      }
      setOwn(out, key, named);
      continue;
    }
    setOwn(out, key, structureOf(value));
  }
  return out;
}

/**
 * The tool as kept: name, description (clipped to the listing limit) and the
 * input schema's structure. No title, annotations, output schema or any value
 * keyword. Null when the tool cannot be kept (nested too deep for a recursive
 * walk), in which case the whole observation is dropped: a list with a tool
 * missing is not the server's list.
 */
export function memberObservedTool(tool: MemberObservedTool) {
  if (marketMcpNestsDeeperThan(tool.inputSchema, MARKET_MCP_TOOL_MAX_NESTING)) {
    return null;
  }
  const description = tool.description?.slice(0, MARKET_MCP_INSPECT_LIMITS.descriptionChars);
  return {
    name: tool.name,
    ...(description ? { description } : {}),
    inputSchema: structureOf(tool.inputSchema) as Record<string, unknown>,
  };
}

