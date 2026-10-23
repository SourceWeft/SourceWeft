import { describe, expect, it } from "vitest";
import {
  mcpDocumentationUrl,
  mcpEndpointHost,
  mcpPublisherDomain,
} from "./mcp-facts";

describe("mcpEndpointHost", () => {
  it("is the host of an http(s) URL, port included, and nothing else", () => {
    expect(mcpEndpointHost("https://mcp.notion.com/mcp?x=1")).toBe(
      "mcp.notion.com",
    );
    expect(mcpEndpointHost("http://localhost:8080/mcp")).toBe("localhost:8080");
    for (const value of [
      undefined,
      null,
      "",
      "  ",
      "not a url",
      "ftp://x.test/a",
      "javascript:alert(1)",
    ]) {
      expect(mcpEndpointHost(value)).toBeNull();
    }
  });
});

// #367 W2 writes `publisher` onto the manifest and the catalog item; W4
// reads it wherever it is, and does without it where it is not yet.
describe("mcpPublisherDomain", () => {
  it("reads a publisher's domain from a manifest or item, lowercased", () => {
    expect(
      mcpPublisherDomain({
        name: "Notion",
        publisher: {
          domain: "Notion.com",
          source: "registry-namespace",
          endpointMatch: true,
        },
      }),
    ).toBe("notion.com");
  });

  it("is null without one, or with something that is not a domain", () => {
    for (const value of [
      undefined,
      null,
      {},
      { name: "X" },
      { publisher: null },
      { publisher: "notion.com" },
      { publisher: {} },
      { publisher: { domain: 7 } },
      { publisher: { domain: "" } },
      { publisher: { domain: "not a domain" } },
      { publisher: { domain: "https://notion.com" } },
    ]) {
      expect(mcpPublisherDomain(value as never)).toBeNull();
    }
  });
});

// #367 W1 keeps RFC 9728 `resource_documentation` in the provenance.
describe("mcpDocumentationUrl", () => {
  it("is the documentation URL the server's auth metadata names", () => {
    expect(
      mcpDocumentationUrl({
        authMetadata: {
          resourceName: "Notion MCP",
          resourceDocumentation: " https://developers.notion.com/docs/mcp ",
        },
      }),
    ).toBe("https://developers.notion.com/docs/mcp");
  });

  it("is null without one, or when it is not an http(s) URL", () => {
    for (const value of [
      undefined,
      null,
      "x",
      {},
      { authMetadata: null },
      { authMetadata: {} },
      { authMetadata: { resourceDocumentation: 1 } },
      { authMetadata: { resourceDocumentation: "" } },
      { authMetadata: { resourceDocumentation: "javascript:alert(1)" } },
      { authMetadata: { resourceDocumentation: "docs/mcp" } },
    ]) {
      expect(mcpDocumentationUrl(value)).toBeNull();
    }
  });
});
