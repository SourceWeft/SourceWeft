import assert from "node:assert/strict";
import { test } from "vitest";
import type { GithubRegistryRow } from "./fetch";
import {
  identifierNamespace,
  matchGithubRegistryRow,
  namespaceDomain,
  registrableDomain,
  urlHost,
} from "./match";

function row(
  name: string,
  remoteUrl: string | undefined,
  isInOrganization = true,
): GithubRegistryRow {
  return { name, remoteUrl, github: { isInOrganization } };
}

test("registrable domain: last two labels, three under a country second level, none for IPs", () => {
  assert.equal(registrableDomain("mcp.notion.com"), "notion.com");
  assert.equal(registrableDomain("notion.com"), "notion.com");
  assert.equal(registrableDomain("MCP.Notion.COM."), "notion.com");
  assert.equal(registrableDomain("api.example.co.uk"), "example.co.uk");
  assert.equal(registrableDomain("mcp.example.com.au"), "example.com.au");
  assert.equal(registrableDomain("learn.microsoft.com"), "microsoft.com");
  // The documented limitation: a public suffix the rule does not know.
  assert.equal(registrableDomain("acme.github.io"), "github.io");
  assert.equal(registrableDomain("localhost"), undefined);
  assert.equal(registrableDomain("10.0.0.1"), undefined);
  assert.equal(registrableDomain("[::1]"), undefined);
});

test("namespace domain reverses the labels", () => {
  assert.equal(namespaceDomain("com.notion"), "notion.com");
  assert.equal(namespaceDomain("tech.neon"), "neon.tech");
  assert.equal(namespaceDomain("io.github.acme"), "acme.github.io");
  assert.equal(namespaceDomain("uk.co.example"), "example.co.uk");
  assert.equal(namespaceDomain("local"), undefined);
  assert.equal(identifierNamespace("com.notion/mcp"), "com.notion");
});

test("url host: lowercased http(s) hosts only", () => {
  assert.equal(urlHost("https://MCP.Notion.com/mcp"), "mcp.notion.com");
  assert.equal(urlHost("http://mcp.notion.com:8080/x"), "mcp.notion.com");
  assert.equal(urlHost("{zapier_mcp_url}"), undefined);
  assert.equal(urlHost("ftp://mcp.notion.com/"), undefined);
  assert.equal(urlHost(undefined), undefined);
  assert.equal(urlHost(null), undefined);
});

test("rule (a): the same reverse-DNS name matches, exactly", () => {
  const target = {
    identifier: "io.github.netdata/mcp-server",
    endpointUrl: "https://app.netdata.cloud/api/v1/mcp",
  };
  assert.deepEqual(
    matchGithubRegistryRow(
      row(
        "io.github.netdata/mcp-server",
        "https://app.netdata.cloud/api/v1/mcp",
        false,
      ),
      target,
    ),
    { matchedBy: "name" },
  );
  assert.equal(
    matchGithubRegistryRow(
      row("io.github.Netdata/mcp-server", undefined),
      target,
    ),
    null,
  );
  assert.equal(
    matchGithubRegistryRow(
      row("io.github.netdata/mcp-server-2", undefined),
      target,
    ),
    null,
  );
});

test("rule (b): Notion's owner/repo row matches com.notion/mcp by endpoint host, namespace domain and organization", () => {
  const notion = row(
    "makenotion/notion-mcp-server",
    "https://mcp.notion.com/sse",
  );
  assert.deepEqual(
    matchGithubRegistryRow(notion, {
      identifier: "com.notion/mcp",
      endpointUrl: "https://mcp.notion.com/mcp",
    }),
    { matchedBy: "endpoint-domain-org" },
  );
  // Host comparison ignores case; the path is not part of the rule.
  assert.deepEqual(
    matchGithubRegistryRow(notion, {
      identifier: "com.notion/mcp",
      endpointUrl: "https://MCP.notion.com/",
    }),
    { matchedBy: "endpoint-domain-org" },
  );
});

test("rule (b) negatives: another namespace on the same host, no organization, a host that only contains ours, no endpoint", () => {
  const notion = row(
    "makenotion/notion-mcp-server",
    "https://mcp.notion.com/sse",
  );
  // Same host, but our namespace names another domain.
  assert.equal(
    matchGithubRegistryRow(notion, {
      identifier: "com.example/notion",
      endpointUrl: "https://mcp.notion.com/mcp",
    }),
    null,
  );
  // Everything lines up except the repository is a personal one.
  assert.equal(
    matchGithubRegistryRow(
      row("antfu/nuxt-mcp", "https://mcp.nuxt.com/sse", false),
      { identifier: "com.nuxt/mcp", endpointUrl: "https://mcp.nuxt.com/mcp" },
    ),
    null,
  );
  // Substring hosts: a different subdomain, a look-alike suffix, a prefix.
  for (const endpointUrl of [
    "https://notion.com/mcp",
    "https://mymcp.notion.com/mcp",
    "https://mcp.notion.com.evil.net/mcp",
    "https://evil-mcp.notion.com.example/mcp",
  ]) {
    assert.equal(
      matchGithubRegistryRow(notion, {
        identifier: "com.notion/mcp",
        endpointUrl,
      }),
      null,
      endpointUrl,
    );
  }
  // A row whose first remote is a template, or that has none.
  assert.equal(
    matchGithubRegistryRow(row("zapier/zapier-mcp", "{zapier_mcp_url}"), {
      identifier: "com.zapier/mcp",
      endpointUrl: "https://mcp.zapier.com/api/mcp/mcp",
    }),
    null,
  );
  assert.equal(
    matchGithubRegistryRow(row("makenotion/notion-mcp-server", undefined), {
      identifier: "com.notion/mcp",
      endpointUrl: "https://mcp.notion.com/mcp",
    }),
    null,
  );
  // Our entry is stdio-only: nothing to compare hosts against.
  assert.equal(
    matchGithubRegistryRow(notion, {
      identifier: "com.notion/mcp",
      endpointUrl: null,
    }),
    null,
  );
});

test("rule (b) never applies to io.github namespaces: their domain is a GitHub Pages suffix", () => {
  assert.equal(
    matchGithubRegistryRow(row("acme/acme-mcp", "https://acme.github.io/mcp"), {
      identifier: "io.github.acme/mcp",
      endpointUrl: "https://acme.github.io/mcp",
    }),
    null,
  );
});
