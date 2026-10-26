import { describe, expect, test } from "vitest";
import { isAccountSpecificGatewayHost } from "./account-gateways";
import { endpointKeyHash, pinEndpoint, pinOrigin, sameEndpoint } from "./endpoint-pin";

const manifest = "https://mcp.example.com/mcp";

describe("endpoint pin", () => {
  test.each([
    ["https://mcp.example.com/mcp"],
    ["HTTPS://MCP.Example.COM/mcp"],
    ["https://mcp.example.com:443/mcp"],
    ["https://mcp.example.com./mcp"],
    ["https://mcp.example.com/mcp#frag"],
    ["https://mcp.example.com/other/../mcp"],
  ])("%s is the same endpoint", (candidate) => {
    expect(sameEndpoint(candidate, manifest)).toBe(true);
  });

  test.each([
    ["different path", "https://mcp.example.com/mcp2"],
    ["trailing slash", "https://mcp.example.com/mcp/"],
    ["different port", "https://mcp.example.com:8443/mcp"],
    ["different scheme", "http://mcp.example.com/mcp"],
    ["different host", "https://mcp.example.org/mcp"],
    ["subdomain", "https://x.mcp.example.com/mcp"],
    ["query added", "https://mcp.example.com/mcp?tenant=a"],
    ["userinfo", "https://user:pw@mcp.example.com/mcp"],
    ["userinfo name only", "https://user@mcp.example.com/mcp"],
    ["userinfo as host lookalike", "https://mcp.example.com@evil.example/mcp"],
    ["backslash host trick", "https://evil.example\\@mcp.example.com/mcp"],
    ["encoded path", "https://mcp.example.com/%6dcp"],
    ["other scheme", "ftp://mcp.example.com/mcp"],
    ["not a URL", "mcp.example.com/mcp"],
    ["empty", ""],
  ])("%s is not the same endpoint", (_name, candidate) => {
    expect(sameEndpoint(candidate, manifest)).toBe(false);
  });

  test("a manifest endpoint that cannot be pinned never matches", () => {
    expect(sameEndpoint(manifest, null)).toBe(false);
    expect(sameEndpoint(manifest, undefined)).toBe(false);
    expect(sameEndpoint(manifest, "https://u:p@mcp.example.com/mcp")).toBe(false);
    expect(sameEndpoint("not a url", "not a url")).toBe(false);
  });

  test("the query is part of the pin", () => {
    expect(
      sameEndpoint("https://a.example/mcp?x=1", "https://a.example/mcp?x=1"),
    ).toBe(true);
    expect(
      sameEndpoint("https://a.example/mcp?x=1", "https://a.example/mcp?x=2"),
    ).toBe(false);
  });

  test("a bare origin has no path, query or credentials", () => {
    expect(pinOrigin("https://mcp.example.com")).toBe("https://mcp.example.com");
    expect(pinOrigin("https://MCP.example.com./")).toBe("https://mcp.example.com");
    expect(pinOrigin("https://mcp.example.com:8443")).toBe("https://mcp.example.com:8443");
    expect(pinOrigin("https://mcp.example.com/mcp")).toBeNull();
    expect(pinOrigin("https://mcp.example.com/?a=1")).toBeNull();
    expect(pinOrigin("https://u@mcp.example.com")).toBeNull();
    expect(pinOrigin("nope")).toBeNull();
  });

  test("the stored key is a hash, not the endpoint", () => {
    const hash = endpointKeyHash(pinEndpoint("https://mcp.example.com/mcp?secret=1")!);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("example");
  });
});

describe("account-specific gateways", () => {
  test.each([
    "zapier.com",
    "mcp.zapier.com",
    "MCP.ZAPIER.COM",
    "mcp.zapier.com.",
    "a.b.composio.dev",
    "mcp.pipedream.net",
    "server.smithery.ai",
    "mcp.run",
    "x.mcp.run",
  ])("%s is a gateway", (host) => {
    expect(isAccountSpecificGatewayHost(host)).toBe(true);
  });

  test.each(["mcp.notion.com", "notzapier.com", "zapier.com.evil.example", "mcp.runner.dev"])(
    "%s is not a gateway",
    (host) => {
      expect(isAccountSpecificGatewayHost(host)).toBe(false);
    },
  );
});
