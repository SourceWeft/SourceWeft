import { describe, expect, test } from "vitest";
import { evaluateSiteTrust } from "./site-trust";

describe("tier A", () => {
  test("a verified domain namespace with the endpoint under that domain", () => {
    const trust = evaluateSiteTrust({
      namespace: "com.notion",
      namespaceVerified: true,
      endpointUrl: "https://mcp.notion.com/mcp",
    });
    expect(trust).toMatchObject({ tier: "A", host: "notion.com", domain: "notion.com" });
  });

  test("an unverified namespace is not evidence, whatever the endpoint", () => {
    const trust = evaluateSiteTrust({
      namespace: "com.notion",
      endpointUrl: "https://mcp.notion.com/mcp",
    });
    expect(trust.tier).not.toBe("A");
  });

  test("a domain namespace whose endpoint is elsewhere is not A", () => {
    const trust = evaluateSiteTrust({
      namespace: "com.acme",
      namespaceVerified: true,
      endpointUrl: "https://acme-mcp.workers.dev/mcp",
    });
    expect(trust.tier).not.toBe("A");
  });

  test("reserved and local top-level labels never name a domain", () => {
    for (const namespace of ["local.printer", "test.acme", "internal.corp"]) {
      expect(
        evaluateSiteTrust({
          namespace,
          namespaceVerified: true,
          endpointUrl: "https://mcp.printer.local/mcp",
        }).tier,
      ).not.toBe("A");
    }
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
        namespaceVerified: true,
        endpointUrl: "https://github.io/acme",
      }).tier,
    ).not.toBe("A");
  });
});

describe("tier B", () => {
  test("a declared website whose domain hosts the endpoint", () => {
    const trust = evaluateSiteTrust({
      namespace: "io.github.acme",
      endpointUrl: "https://mcp.acme.io/sse",
      registryWebsiteUrl: "https://www.acme.io/product",
    });
    expect(trust).toMatchObject({ tier: "B", host: "www.acme.io", domain: "acme.io" });
    expect(trust.reasons).toContain("endpoint-under:mcp.acme.io");
  });

  test("any one declaring field will do when the endpoint proves control", () => {
    for (const field of ["serverInfoWebsiteUrl", "resourceDocumentationUrl"] as const) {
      const trust = evaluateSiteTrust({
        namespace: "io.github.acme",
        endpointUrl: "https://mcp.acme.io/sse",
        [field]: "https://acme.io/docs",
      });
      expect(trust.tier).toBe("B");
    }
  });
});

describe("tier C", () => {
  test("agreeing declarations without control evidence stay C, however many fields", () => {
    const trust = evaluateSiteTrust({
      namespace: "io.github.acme",
      endpointUrl: "https://mcp.elsewhere.net/sse",
      registryWebsiteUrl: "https://bigbrand.com",
      serverInfoWebsiteUrl: "https://bigbrand.com",
      resourceDocumentationUrl: "https://bigbrand.com/docs",
    });
    expect(trust).toEqual({
      tier: "C",
      declaredDomains: ["bigbrand.com"],
      reasons: ["declared-website-without-control-evidence"],
    });
  });

  test("a hyphen-lookalike GitHub owner does not turn a brand's website into B", () => {
    // `s-t-r-i-p-e` is not stripe, whatever its name normalizes to.
    expect(
      evaluateSiteTrust({
        namespace: "io.github.s-t-r-i-p-e",
        repositoryUrl: "https://github.com/s-t-r-i-p-e/x",
        registryWebsiteUrl: "https://stripe.com",
        serverInfoWebsiteUrl: "https://stripe.com",
      } as never).tier,
    ).toBe("C");
  });

  test("a repository on a brand's own domain or any other code host proves nothing", () => {
    for (const repositoryUrl of [
      "https://git.stripe.com/x/y",
      "https://huggingface.co/stripe/x",
      "https://bitbucket.org/stripe/x",
      "https://codeberg.org/stripe/x",
    ]) {
      expect(
        evaluateSiteTrust({
          namespace: "io.github.mallory",
          endpointUrl: "https://mallory.example/mcp",
          registryWebsiteUrl: "https://stripe.com",
          serverInfoWebsiteUrl: "https://stripe.com",
          repositoryUrl,
        } as never).tier,
      ).toBe("C");
    }
  });

  test("two projects on one shared host are different sites", () => {
    const trust = evaluateSiteTrust({
      namespace: "io.github.acme",
      endpointUrl: "https://a.github.io/mcp",
      registryWebsiteUrl: "https://b.github.io",
    });
    expect(trust.tier).toBe("C");
  });

  test("the endpoint on a shared host does not make that host's other sites B", () => {
    const trust = evaluateSiteTrust({
      namespace: "io.github.acme",
      endpointUrl: "https://acme.workers.dev/mcp",
      registryWebsiteUrl: "https://victim.workers.dev",
    });
    expect(trust.tier).toBe("C");
  });

  test("nothing declared is reported as none", () => {
    expect(evaluateSiteTrust({ namespace: "io.github.acme" }).tier).toBe("none");
  });
});
