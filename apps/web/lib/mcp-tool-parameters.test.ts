import { describe, expect, it } from "vitest";
import { mcpToolParameters } from "./mcp-tool-parameters";

describe("mcpToolParameters", () => {
  it("names the schema's properties in order, marking the required ones", () => {
    expect(
      mcpToolParameters({
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "integer" } },
        required: ["query", "missing", 3],
      }),
    ).toEqual([
      { name: "query", required: true },
      { name: "limit", required: false },
    ]);
  });

  it("finds no parameters in a schema without properties", () => {
    for (const schema of [
      undefined,
      {},
      { type: "object" },
      { properties: null },
      { properties: ["query"] },
    ]) {
      expect(mcpToolParameters(schema)).toEqual([]);
    }
  });
});
