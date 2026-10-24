import { describe, expect, test } from "vitest";
import { evaluateSiteTrust } from "./site-trust";

describe("tier A", () => {
  test("a domain namespace with the endpoint under that domain", () => {
    const trust = evaluateSiteTrust({
      namespace: "com.notion",
      endpointUrl: "https://mcp.notion.com/mcp",
    });
    expect(trust).toMatchObject({ tier: "A", host: "notion.com", domain: "notion.com" });
  });

  test("a domain namespace whose endpoint is elsewhere is not A", () => {
    const trust = evaluateSiteTrust({
      namespace: "com.acme",
      endpointUrl: "https://acme-mcp.workers.dev/mcp",
    });
    expect(trust.tier).not.toBe("A");
  });

  test("a verified domain claim is A for the claimed domain only", () => {
    const trust = evaluateSiteTrust({
      namespace: "io.github.someone",
      registryWebsiteUrl: "https://other.example",
      claimedDomains: ["someone.dev"],
    });
    expect(trust).toMatchObject({ tier: "A", host: "someone.dev", domain: "someone.dev" });
  });

  test("a GitHub namespace is not a domain namespace", () => {
    expect(
      evaluateSiteTrust({
        namespace: "io.github.acme",
        endpointUrl: "https://github.io/acme",
      }).tier,
    ).not.toBe("A");
  });
});

describe("tier B", () => {
  test("two independent channels agree on a domain that is the endpoint's", () => {
    const trust = evaluateSiteTrust({
      namespace: "io.github.acme",
      endpointUrl: "https://mcp.acme.io/sse",
      registryWebsiteUrl: "https://www.acme.io/product",
      serverInfoWebsiteUrl: "https://acme.io",
    });
    expect(trust).toMatchObject({ tier: "B", domain: "acme.io" });
    expect(trust.reasons).toContain("consistent:endpoint-domain");
  });

  test("agreement is consistent with the declared repository's owner", () => {
    const trust = evaluateSiteTrust({
      namespace: "io.github.acme",
      repositoryUrl: "https://github.com/acme/mcp-server",
      registryWebsiteUrl: "https://acme.dev",
      serverInfoWebsiteUrl: "https://acme.dev/docs",
    });
    expect(trust).toMatchObject({ tier: "B", domain: "acme.dev" });
    expect(trust.reasons).toContain("consistent:repository-owner");
  });
});

describe("tier C", () => {
  test("a single declaration is C and names no site to fetch", () => {
    const trust = evaluateSiteTrust({
      namespace: "io.github.acme",
      endpointUrl: "https://mcp.acme.io/sse",
      registryWebsiteUrl: "https://acme.io",
    });
    expect(trust).toEqual({
      tier: "C",
      declaredDomains: ["acme.io"],
      reasons: ["single-or-unconfirmed-declaration"],
    });
  });

  test("two fields copied from one channel count once", () => {
    // serverInfo.websiteUrl and resource_documentation are both the endpoint's
    // own words.
    const trust = evaluateSiteTrust({
      namespace: "io.github.acme",
      endpointUrl: "https://mcp.acme.io/sse",
      serverInfoWebsiteUrl: "https://acme.io",
      resourceDocumentationUrl: "https://acme.io/docs",
    });
    expect(trust.tier).toBe("C");
  });

  test("channels that name different domains do not corroborate", () => {
    const trust = evaluateSiteTrust({
      namespace: "io.github.acme",
      endpointUrl: "https://mcp.acme.io/sse",
      registryWebsiteUrl: "https://acme.io",
      serverInfoWebsiteUrl: "https://acme-corp.com",
    });
    expect(trust.tier).toBe("C");
  });

  test("agreeing channels that match neither endpoint nor repository stay C", () => {
    const trust = evaluateSiteTrust({
      namespace: "io.github.acme",
      endpointUrl: "https://mcp.elsewhere.net/sse",
      repositoryUrl: "https://github.com/acme/x",
      registryWebsiteUrl: "https://bigbrand.com",
      serverInfoWebsiteUrl: "https://bigbrand.com",
    });
    expect(trust.tier).toBe("C");
  });

  test("two projects on one shared host are different sites", () => {
    const trust = evaluateSiteTrust({
      namespace: "io.github.acme",
      endpointUrl: "https://a.github.io/mcp",
      registryWebsiteUrl: "https://a.github.io",
      serverInfoWebsiteUrl: "https://b.github.io",
    });
    expect(trust.tier).toBe("C");
  });

  test("nothing declared is reported as none", () => {
    expect(evaluateSiteTrust({ namespace: "io.github.acme" }).tier).toBe("none");
  });
});
