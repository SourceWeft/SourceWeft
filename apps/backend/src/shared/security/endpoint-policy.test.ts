import assert from "node:assert/strict";
import { test } from "vitest";
import {
  parseAllowedInternalOrigins,
  resolveEndpointAddresses,
  validateEndpointUrl,
} from "./endpoint-policy";

test("internal origins are exact, canonical and configuration errors do not echo secrets", () => {
  assert.deepEqual(
    parseAllowedInternalOrigins("MCP_ALLOWED_INTERNAL_ORIGINS", undefined),
    [],
  );
  assert.deepEqual(
    parseAllowedInternalOrigins(
      "MCP_ALLOWED_INTERNAL_ORIGINS",
      '["HTTPS://Service.Internal:443/","https://service.internal"]',
    ),
    ["https://service.internal"],
  );
  for (const raw of [
    "{}",
    "true",
    "[42]",
    '["https://*.internal"]',
    '["https://x.internal/v1"]',
    '["http://user:secret@x.internal"]',
    '["https://x.internal?token=secret"]',
  ]) {
    assert.throws(
      () => parseAllowedInternalOrigins("MCP_ALLOWED_INTERNAL_ORIGINS", raw),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /MCP_ALLOWED_INTERNAL_ORIGINS/);
        assert.ok(!error.message.includes("secret"));
        return true;
      },
    );
  }
});

test("strict policy permits private DNS and HTTP only for exact internal origins", async () => {
  const policy = {
    enforceAddressChecks: true,
    allowedInternalOrigins: [
      "http://mcp.internal:8080",
      "https://sso.internal",
      "http://127.0.0.1:11434",
    ],
  };
  const privateDns = async () => [{ address: "10.0.0.5", family: 4 }];
  for (const url of [
    "http://mcp.internal:8080/mcp",
    "https://sso.internal/token",
    "http://127.0.0.1:11434/v1",
  ]) {
    assert.ok(await validateEndpointUrl(url, policy, privateDns));
  }
  for (const url of [
    "http://mcp.internal:8081/mcp",
    "https://other.internal",
    "http://127.0.0.1:11435/v1",
  ]) {
    await assert.rejects(validateEndpointUrl(url, policy, privateDns));
  }
  await assert.rejects(
    validateEndpointUrl("https://sso.internal/token", policy, async () => [
      { address: "127.0.0.1", family: 4 },
    ]),
  );
});

test("development prechecks skip DNS and address restrictions but keep URL validation", async () => {
  const policy = { enforceAddressChecks: false, allowedInternalOrigins: [] };
  const unexpectedLookup = async () => {
    throw new Error("precheck must not resolve DNS");
  };
  for (const url of [
    "http://localhost:11434/v1",
    "http://unresolved.internal:8000/v1",
    "https://api.deepseek.com/v1",
    "https://198.18.0.20/v1",
    "http://10.0.0.1/mcp",
  ]) {
    assert.equal(
      (await validateEndpointUrl(url, policy, unexpectedLookup)).href,
      url,
    );
  }
  for (const url of [
    "file:///etc/passwd",
    "ftp://localhost/",
    "https://user:secret@localhost/",
  ]) {
    await assert.rejects(validateEndpointUrl(url, policy, unexpectedLookup));
  }
});

test("connection lookup retains fake-IP results only when address checks are disabled", async () => {
  const url = new URL("https://api.deepseek.com/v1");
  const addresses = [
    { address: "198.18.0.20", family: 4 },
    { address: "10.0.0.5", family: 4 },
  ];
  const policy = { enforceAddressChecks: false, allowedInternalOrigins: [] };
  assert.deepEqual(
    await resolveEndpointAddresses(url, policy, async () => addresses),
    addresses,
  );
  await assert.rejects(
    resolveEndpointAddresses(
      url,
      { ...policy, enforceAddressChecks: true },
      async () => addresses,
    ),
  );
  await assert.rejects(
    resolveEndpointAddresses(url, policy, async () => []),
    /resolve/,
  );
  const failure = new Error("DNS lookup failed");
  await assert.rejects(
    resolveEndpointAddresses(url, policy, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
});

test("internal permission never authorizes metadata, link-local, multicast or unspecified addresses", async () => {
  for (const host of [
    "169.254.169.254",
    "0.0.0.0",
    "224.0.0.1",
    "[fe90::1]",
    "[::ffff:a9fe:a9fe]",
  ]) {
    const origin = `http://${host}`;
    await assert.rejects(
      validateEndpointUrl(origin, {
        enforceAddressChecks: true,
        allowedInternalOrigins: [origin],
      }),
    );
  }
  await assert.rejects(
    validateEndpointUrl(
      "https://public.example",
      { enforceAddressChecks: true, allowedInternalOrigins: [] },
      async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ],
    ),
  );
});
