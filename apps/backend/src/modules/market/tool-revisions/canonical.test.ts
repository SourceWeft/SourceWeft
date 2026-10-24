import { describe, expect, test } from "vitest";
import {
  ToolRevisionInputError,
  canonicalizeTools,
  diffTools,
  hashCanonicalTools,
  validateTools,
} from "./canonical";

const hashOf = (tools: unknown[]) =>
  hashCanonicalTools(canonicalizeTools(validateTools(tools)));
const canon = (tools: unknown[]) => canonicalizeTools(validateTools(tools));

const search = {
  name: "search",
  description: "Search the index",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "number" } },
    required: ["query"],
  },
  annotations: { readOnlyHint: true, title: "Search" },
};
const fetchTool = { name: "fetch", description: "Fetch a page", inputSchema: { type: "object" } };

describe("canonical hash", () => {
  test("is stable under tool order, key order at every depth and description whitespace", () => {
    const reordered = {
      annotations: { title: "Search", readOnlyHint: true },
      inputSchema: {
        required: ["query"],
        properties: { limit: { type: "number" }, query: { type: "string" } },
        type: "object",
      },
      description: "  Search   the\n index \t",
      name: "search",
    };
    expect(hashOf([search, fetchTool])).toBe(hashOf([fetchTool, reordered]));
  });

  test("keeps array order inside schemas: enum order is content", () => {
    const withEnum = (values: string[]) => ({
      name: "pick",
      inputSchema: { type: "object", properties: { mode: { enum: values } } },
    });
    expect(hashOf([withEnum(["a", "b"])])).not.toBe(hashOf([withEnum(["b", "a"])]));
  });

  test("treats an omitted description, an empty one and defaults alike", () => {
    expect(hashOf([{ name: "t" }])).toBe(
      hashOf([{ name: "t", description: "   ", inputSchema: {}, annotations: {} }]),
    );
  });

  test("a different description, schema or annotation changes the hash", () => {
    const base = hashOf([search]);
    expect(hashOf([{ ...search, description: "Search the web" }])).not.toBe(base);
    expect(hashOf([{ ...search, inputSchema: { type: "object" } }])).not.toBe(base);
    expect(hashOf([{ ...search, annotations: {} }])).not.toBe(base);
  });

  test("the empty list has a stable hash of its own", () => {
    expect(hashOf([])).toBe(hashOf([]));
    expect(hashOf([])).not.toBe(hashOf([fetchTool]));
  });
});

describe("diff", () => {
  test("lists added, removed and which field changed", () => {
    const previous = canon([search, fetchTool, { name: "gone" }]);
    const next = canon([
      { ...search, description: "Search everything" },
      { ...fetchTool, inputSchema: { type: "object", properties: { url: { type: "string" } } } },
      { name: "fresh" },
    ]);
    expect(diffTools(previous, next)).toEqual({
      added: ["fresh"],
      removed: ["gone"],
      changed: [
        { name: "fetch", fields: ["inputSchema"] },
        { name: "search", fields: ["description"] },
      ],
    });
  });

  test("reports annotations and several fields at once", () => {
    const diff = diffTools(
      canon([search]),
      canon([{ ...search, title: "Finder", annotations: { readOnlyHint: false } }]),
    );
    expect(diff.changed).toEqual([{ name: "search", fields: ["title", "annotations"] }]);
  });

  test("no difference when only formatting changed", () => {
    expect(
      diffTools(canon([search]), canon([{ ...search, description: " Search   the index" }])),
    ).toEqual({ added: [], removed: [], changed: [] });
  });

  test("against nothing, everything is added", () => {
    expect(diffTools([], canon([fetchTool, search])).added).toEqual(["fetch", "search"]);
  });
});

describe("bounds", () => {
  test("rejects more than 200 tools, long descriptions and oversized tools", () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ name: `t${i}` }));
    expect(() => validateTools(many)).toThrow(ToolRevisionInputError);
    expect(() => validateTools([{ name: "t", description: "x".repeat(2001) }])).toThrow(
      ToolRevisionInputError,
    );
    expect(() =>
      validateTools([{ name: "t", inputSchema: { blob: "x".repeat(33 * 1024) } }]),
    ).toThrow(ToolRevisionInputError);
    expect(validateTools(Array.from({ length: 200 }, (_, i) => ({ name: `t${i}` })))).toHaveLength(
      200,
    );
  });

  test("rejects a repeated name and non-tools", () => {
    expect(() => validateTools([{ name: "a" }, { name: "a" }])).toThrow(
      expect.objectContaining({ code: "TOOLS_DUPLICATE_NAME" }),
    );
    expect(() => validateTools([{ nope: true }])).toThrow(
      expect.objectContaining({ code: "TOOLS_INVALID" }),
    );
  });
});
