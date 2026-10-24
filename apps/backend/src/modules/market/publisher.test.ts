import assert from "node:assert/strict";
import { test } from "vitest";
import {
  endpointMatchesDomain,
  publisherDomainFromNamespace,
  publisherFromRegistryName,
  publisherMeta,
} from "./publisher";

test("a reverse-DNS namespace names its domain with the labels reversed", () => {
  assert.equal(publisherDomainFromNamespace("com.notion"), "notion.com");
  assert.equal(publisherDomainFromNamespace("ai.com.mcp"), "mcp.com.ai");
  assert.equal(
    publisherDomainFromNamespace("ac.inference.sh"),
    "sh.inference.ac",
  );
  assert.equal(publisherDomainFromNamespace("Com.Notion "), "notion.com");
});

test("io.github namespaces are GitHub accounts, not domain publishers", () => {
  assert.equal(publisherDomainFromNamespace("io.github.acme"), undefined);
  assert.equal(publisherDomainFromNamespace("io.github.acme-labs"), undefined);
  assert.equal(
    publisherFromRegistryName("io.github.acme/server", undefined),
    undefined,
  );
  assert.equal(
    publisherFromRegistryName(
      "io.github.github/github-mcp-server",
      "https://api.githubcopilot.com/mcp/",
    ),
    undefined,
  );
});

test("a namespace without a dot, or with a malformed label, names no domain", () => {
  assert.equal(publisherDomainFromNamespace("notion"), undefined);
  assert.equal(publisherDomainFromNamespace(""), undefined);
  assert.equal(publisherDomainFromNamespace("com..notion"), undefined);
  assert.equal(publisherDomainFromNamespace("com.-notion"), undefined);
  assert.equal(publisherDomainFromNamespace("com.no tion"), undefined);
});

test("the endpoint matches the domain itself or a subdomain of it", () => {
  assert.equal(
    endpointMatchesDomain("https://mcp.notion.com/mcp", "notion.com"),
    true,
  );
  assert.equal(
    endpointMatchesDomain("https://notion.com/mcp", "notion.com"),
    true,
  );
  assert.equal(
    endpointMatchesDomain("https://MCP.Notion.COM./mcp", "notion.com"),
    true,
  );
  assert.equal(
    endpointMatchesDomain("https://a.b.notion.com:8443/sse?x=1", "notion.com"),
    true,
  );
});

test("a host that merely contains the domain as a substring does not match", () => {
  assert.equal(
    endpointMatchesDomain("https://notnotion.com/mcp", "notion.com"),
    false,
  );
  assert.equal(
    endpointMatchesDomain("https://notion.com.evil.test/mcp", "notion.com"),
    false,
  );
  assert.equal(
    endpointMatchesDomain("https://mcp.notion.community/mcp", "notion.com"),
    false,
  );
  assert.equal(
    endpointMatchesDomain("https://notion.com.au/mcp", "notion.com"),
    false,
  );
});

test("no endpoint, or one that does not parse, matches nothing", () => {
  assert.equal(endpointMatchesDomain(undefined, "notion.com"), false);
  assert.equal(endpointMatchesDomain("", "notion.com"), false);
  assert.equal(endpointMatchesDomain("not a url", "notion.com"), false);
});

test("the publisher of a domain namespace says whether it runs the endpoint", () => {
  assert.deepEqual(
    publisherFromRegistryName("com.notion/mcp", "https://mcp.notion.com/mcp"),
    { domain: "notion.com", source: "registry-namespace", endpointMatch: true },
  );
  assert.deepEqual(
    publisherFromRegistryName("com.notion/mcp", "https://mcp.example.com/mcp"),
    {
      domain: "notion.com",
      source: "registry-namespace",
      endpointMatch: false,
    },
  );
  // A stdio-only server has no endpoint to match.
  assert.deepEqual(publisherFromRegistryName("com.notion/cli", undefined), {
    domain: "notion.com",
    source: "registry-namespace",
    endpointMatch: false,
  });
});

test("the stored publisher is read only when the contract holds", () => {
  const publisher = {
    domain: "notion.com",
    source: "registry-namespace",
    endpointMatch: true,
  };
  assert.deepEqual(publisherMeta({ publisher }), publisher);
  for (const value of [
    { publisher: { domain: "notion.com" } },
    { publisher: { ...publisher, endpointMatch: "true" } },
    { publisher: { ...publisher, source: "other" } },
    { publisher: "notion.com" },
    {},
    null,
    undefined,
  ]) {
    assert.equal(publisherMeta(value), null, JSON.stringify(value));
  }
});
