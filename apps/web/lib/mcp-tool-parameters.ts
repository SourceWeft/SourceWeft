export type McpToolParameter = { name: string; required: boolean };

/**
 * The parameters a tool's JSON Schema input takes: the names of its
 * `properties` in schema order, each marked when `required` lists it. A schema
 * without properties takes none.
 */
export function mcpToolParameters(
  inputSchema: Record<string, unknown> | undefined,
): McpToolParameter[] {
  const properties = inputSchema?.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  )
    return [];
  const required = new Set(
    Array.isArray(inputSchema?.required)
      ? inputSchema.required.filter(
          (name): name is string => typeof name === "string",
        )
      : [],
  );
  return Object.keys(properties).map((name) => ({
    name,
    required: required.has(name),
  }));
}
