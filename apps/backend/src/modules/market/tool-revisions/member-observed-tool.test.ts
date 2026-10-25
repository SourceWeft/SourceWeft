import { describe, expect, test } from "vitest";
import { memberObservedTool } from "./member-observed-tool";

describe("what of a member's tool is kept", () => {
  test("name, description and the structure of the input schema; values are dropped", () => {
    const kept = memberObservedTool({
      name: "create_page",
      description: "Creates a page.",
      inputSchema: {
        type: "object",
        required: ["parent"],
        properties: {
          parent: {
            type: "string",
            description: "Parent page",
            default: "workspace-8841",
            examples: ["Acme roadmap"],
            enum: ["Acme roadmap", "Private notes"],
          },
          kind: { const: "page" },
          nested: {
            type: "array",
            items: { type: "object", properties: { id: { type: "string", example: "abc" } } },
          },
        },
        additionalProperties: false,
      },
    });
    expect(kept).toEqual({
      name: "create_page",
      description: "Creates a page.",
      inputSchema: {
        type: "object",
        required: ["parent"],
        properties: {
          parent: { type: "string", description: "Parent page" },
          kind: {},
          nested: {
            type: "array",
            items: { type: "object", properties: { id: { type: "string" } } },
          },
        },
        additionalProperties: false,
      },
    });
  });

  test("a property NAMED like a value keyword is a property, not a keyword", () => {
    const kept = memberObservedTool({
      name: "t",
      inputSchema: {
        type: "object",
        properties: { default: { type: "string", default: "x" }, enum: { type: "number" } },
      },
    });
    expect(kept?.inputSchema).toEqual({
      type: "object",
      properties: { default: { type: "string" }, enum: { type: "number" } },
    });
  });

  test("nothing else of the tool is kept", () => {
    const kept = memberObservedTool({
      name: "t",
      inputSchema: {},
      // @ts-expect-error extra fields a caller might pass
      title: "Title",
      annotations: { readOnlyHint: true },
      outputSchema: { type: "object" },
    });
    expect(Object.keys(kept!).sort()).toEqual(["inputSchema", "name"]);
  });

  test("the description is clipped to the listing limit", () => {
    const kept = memberObservedTool({ name: "t", description: "x".repeat(5000), inputSchema: {} });
    expect(kept?.description).toHaveLength(2000);
  });

  test("a __proto__ key stays a plain key and pollutes nothing", () => {
    const inputSchema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string","default":"x"}}}',
    ) as Record<string, unknown>;
    const kept = memberObservedTool({ name: "t", inputSchema });
    const properties = kept!.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).type).toBeUndefined();
    expect(JSON.stringify(properties)).toBe('{"__proto__":{"type":"string"}}');
  });

  test("a schema nested past the limit is refused, not walked", () => {
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 5_000; i++) deep = { items: deep };
    expect(memberObservedTool({ name: "t", inputSchema: deep })).toBeNull();
  });
});
