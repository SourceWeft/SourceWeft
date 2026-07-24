import assert from "node:assert/strict";
import { test } from "vitest";
import { McpError } from "./errors";
import {
  assertSafeMcpEndpoint,
  canonicalJson,
  hashJson,
  normalizedMcpToolName,
  redactErrorMessage,
  redactMcpSecrets,
  resolveCredentialEnvRef,
  sanitizeHeaders,
} from "./security";

function assertMcpError(
  operation: () => unknown,
  code: string,
) {
  assert.throws(
    operation,
    (error) => error instanceof McpError && error.code === code,
  );
}

async function assertMcpRejects(
  operation: () => Promise<unknown>,
  code: string,
) {
  await assert.rejects(
    operation,
    (error) => error instanceof McpError && error.code === code,
  );
}

// Deterministic DNS resolver for tests so we never hit the network. Any host
// mapped here resolves to the given address; unmapped hosts resolve public.
function stubLookup(mapping: Record<string, string>) {
  return async (hostname: string) => {
    const address = mapping[hostname] ?? "93.184.216.34"; // example.com, public
    return [{ address, family: address.includes(":") ? 6 : 4 }];
  };
}

test("assertSafeMcpEndpoint allows public https MCP endpoints", async () => {
  assert.equal(
    await assertSafeMcpEndpoint("https://mcp.example.com/sse", {
      allowLocalhost: false,
      lookup: stubLookup({}),
    }),
    "https://mcp.example.com/sse",
  );
});

test("assertSafeMcpEndpoint allows local http only when explicitly enabled", async () => {
  assert.equal(
    await assertSafeMcpEndpoint("http://localhost:8787/mcp", {
      allowLocalhost: true,
    }),
    "http://localhost:8787/mcp",
  );
  await assertMcpRejects(
    () =>
      assertSafeMcpEndpoint("http://mcp.example.com/mcp", {
        allowLocalhost: true,
        lookup: stubLookup({}),
      }),
    "MCP_ENDPOINT_UNSAFE",
  );
});

test("assertSafeMcpEndpoint rejects credentialed and non-web URLs", async () => {
  await assertMcpRejects(
    () =>
      assertSafeMcpEndpoint("https://user:pass@mcp.example.com/mcp", {
        allowLocalhost: false,
        lookup: stubLookup({}),
      }),
    "MCP_ENDPOINT_UNSAFE",
  );
  await assertMcpRejects(
    () =>
      assertSafeMcpEndpoint("file:///tmp/server", {
        allowLocalhost: false,
      }),
    "MCP_ENDPOINT_UNSAFE",
  );
});

test("assertSafeMcpEndpoint blocks localhost, private, and link-local literal IPs", async () => {
  // Literal IPs are validated without any DNS lookup.
  for (const endpoint of [
    "https://localhost/mcp",
    "https://127.0.0.1/mcp",
    "https://0.0.0.0/mcp",
    "https://10.0.0.5/mcp",
    "https://100.64.0.1/mcp",
    "https://172.16.10.5/mcp",
    "https://192.168.1.10/mcp",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/mcp",
    "https://[fc00::1]/mcp",
    "https://[fe80::1]/mcp",
  ]) {
    await assertMcpRejects(
      () =>
        assertSafeMcpEndpoint(endpoint, {
          allowLocalhost: false,
        }),
      "MCP_ENDPOINT_BLOCKED",
    );
  }
});

test("assertSafeMcpEndpoint blocks DNS rebinding to private and metadata addresses", async () => {
  // A public-looking hostname that resolves to an internal address must be
  // rejected — this is the DNS-rebinding hole the literal-IP-only check missed.
  const lookup = stubLookup({
    "rebind.attacker.com": "169.254.169.254",
    "internal.attacker.com": "10.0.0.5",
    "metadata.google.internal": "169.254.169.254",
  });
  for (const endpoint of [
    "https://rebind.attacker.com/mcp",
    "https://internal.attacker.com/mcp",
    "https://metadata.google.internal/computeMetadata/v1",
  ]) {
    await assertMcpRejects(
      () => assertSafeMcpEndpoint(endpoint, { allowLocalhost: false, lookup }),
      "MCP_ENDPOINT_BLOCKED",
    );
  }
});

test("sanitizeHeaders rejects hop-by-hop and proxy-controlled headers", () => {
  assert.deepEqual(sanitizeHeaders({ "X-Api-Key": "secret" }), {
    "X-Api-Key": "secret",
  });
  assertMcpError(
    () => sanitizeHeaders({ Host: "evil.example.com" }),
    "MCP_HEADER_BLOCKED",
  );
  assertMcpError(
    () => sanitizeHeaders({ "X Forwarded For": "127.0.0.1" }),
    "MCP_HEADER_INVALID",
  );
});

test("redactMcpSecrets redacts nested credential-looking fields", () => {
  assert.deepEqual(
    redactMcpSecrets({
      accessToken: "secret",
      safe: "value",
      nested: {
        api_key: "secret",
        count: 1,
      },
      list: [{ clientSecret: "secret" }],
    }),
    {
      accessToken: "[REDACTED]",
      safe: "value",
      nested: {
        api_key: "[REDACTED]",
        count: 1,
      },
      list: [{ clientSecret: "[REDACTED]" }],
    },
  );
});

test("redactErrorMessage masks secrets embedded in free-text errors", () => {
  const bearer = redactErrorMessage(
    "401 Unauthorized: sent Authorization: Bearer sk-abcdef0123456789abcdef",
  );
  assert.ok(!bearer.includes("sk-abcdef0123456789abcdef"));
  assert.ok(bearer.includes("[REDACTED]"));

  const jwt = redactErrorMessage(
    "token rejected: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
  );
  assert.ok(!jwt.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"));

  const gh = redactErrorMessage("bad credential ghp_0123456789abcdefghijABCDEFabcdef0123");
  assert.ok(!gh.includes("ghp_0123456789abcdefghijABCDEFabcdef0123"));

  // Ordinary error text is left intact.
  assert.equal(
    redactErrorMessage("connection refused by host"),
    "connection refused by host",
  );
});

test("normalizedMcpToolName creates stable LangChain-safe names", () => {
  assert.equal(
    normalizedMcpToolName({
      serverSlug: "GitHub MCP Server",
      toolName: "Create Issue!",
    }),
    "mcp__github_mcp_server__create_issue",
  );
  assert.equal(
    normalizedMcpToolName({
      serverSlug: "!!!",
      toolName: "",
    }),
    "mcp__server__tool",
  );
});

test("resolveCredentialEnvRef resolves env: references and passes literals through", () => {
  const varName = "MCP_CRED_TEST_ENV_REF_TOKEN";
  const previous = process.env[varName];
  try {
    process.env[varName] = "sk-from-env";
    // An exact env:MCP_CRED_* reference resolves from the environment (trims space).
    assert.equal(resolveCredentialEnvRef(`env:${varName}`), "sk-from-env");
    assert.equal(resolveCredentialEnvRef(`  env:${varName}  `), "sk-from-env");
    // A literal secret is returned unchanged.
    assert.equal(resolveCredentialEnvRef("sk-literal-123"), "sk-literal-123");
    // A referenced-but-unset variable resolves to "" (header gets omitted).
    assert.equal(resolveCredentialEnvRef("env:MCP_CRED_DEFINITELY_UNSET"), "");
    // Not a valid reference shape → treated as a literal, not resolved.
    assert.equal(resolveCredentialEnvRef("env:9bad name"), "env:9bad name");
  } finally {
    if (previous === undefined) {
      delete process.env[varName];
    } else {
      process.env[varName] = previous;
    }
  }
});

test("resolveCredentialEnvRef refuses references outside the MCP_CRED_ namespace", () => {
  // The attack this closes: a workspace admin pointing an install at their own
  // endpoint and configuring env:MODEL_GATEWAY_ENCRYPTION_SECRET as the bearer
  // token — which would ship the encryption root to their server on connect.
  process.env.MCP_SECURITY_TEST_FORBIDDEN = "infra-secret";
  try {
    assert.equal(resolveCredentialEnvRef("env:MCP_SECURITY_TEST_FORBIDDEN"), "");
    assert.equal(resolveCredentialEnvRef("env:MODEL_GATEWAY_ENCRYPTION_SECRET"), "");
    assert.equal(resolveCredentialEnvRef("env:DATABASE_URL"), "");
    assert.equal(resolveCredentialEnvRef("env:PATH"), "");
  } finally {
    delete process.env.MCP_SECURITY_TEST_FORBIDDEN;
  }
});

test("canonicalJson and hashJson are stable across object key order", () => {
  const left = { b: 2, a: { d: 4, c: 3 }, skip: undefined };
  const right = { a: { c: 3, d: 4 }, b: 2 };

  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(hashJson(left), hashJson(right));
});
