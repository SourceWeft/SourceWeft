import { describe, expect, it } from "vitest";

import { mcpMeaningfulTerms, relatedMcpItems } from "./mcp-related";

function entry(identifier: string, name: string, summary: string, categories = ["x"]) {
  return { categories, identifier, name, summary };
}

describe("mcpMeaningfulTerms", () => {
  it("leaves out the words every listing uses", () => {
    expect([
      ...mcpMeaningfulTerms("Acme MCP Server", "Cloud API tools for the Acme calendar"),
    ].sort()).toEqual(["acme", "calendar"]);
  });
});

describe("relatedMcpItems", () => {
  const current = entry("a/cal", "Calendar Sync", "Sync your calendar events and invites");

  it("never relates servers by category or generic words alone", () => {
    expect(
      relatedMcpItems({
        candidates: [
          entry("b/db", "Postgres MCP Server", "Cloud API tools for databases", ["x"]),
          entry("c/files", "Files", "A server with tools", ["x"]),
        ],
        current,
      }),
    ).toEqual([]);
  });

  it("needs two meaningful words in common, most shared first", () => {
    const one = entry("b/one", "Calendar", "Notes about nothing else");
    const two = entry("b/two", "Calendar Events", "Create events on a calendar");
    const three = entry("b/three", "Calendar Sync Events", "Sync events and invites to a calendar");
    expect(
      relatedMcpItems({ candidates: [one, two, three], current }).map(
        (item) => item.identifier,
      ),
    ).toEqual(["b/three", "b/two"]);
  });

  it("is empty without a meaningful term of its own and skips itself", () => {
    expect(
      relatedMcpItems({
        candidates: [current],
        current: entry("a/x", "MCP", "Server"),
      }),
    ).toEqual([]);
    expect(relatedMcpItems({ candidates: [current], current })).toEqual([]);
  });

  it("does not relate servers by federation's placeholder summary", () => {
    const placeholder = (identifier: string) =>
      `MCP server ${identifier} from the MCP registry.`;
    const left = entry("io.github.a/one", "One", placeholder("io.github.a/one"));
    expect(mcpMeaningfulTerms(left.name, left.summary)).toEqual(
      new Set(["one"]),
    );
    expect(
      relatedMcpItems({
        candidates: [
          entry("io.github.b/two", "Two", placeholder("io.github.b/two")),
        ],
        current: left,
      }),
    ).toEqual([]);
    // "github" and "registry" are generic even in real text.
    expect([...mcpMeaningfulTerms("GitHub registry tools")]).toEqual([]);
  });

  it("honors the limit", () => {
    const candidates = Array.from({ length: 6 }, (_, index) =>
      entry(`b/${index}`, "Calendar Events", "Calendar events"),
    );
    expect(relatedMcpItems({ candidates, current, limit: 2 })).toHaveLength(2);
  });
});
