import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "vitest";
import type { MarketMcpManifest } from "@sourceweft/market-sdk";
import { McpError } from "./errors";
import {
  parseTrustedMarketPublicKeys,
  verifyMarketManifestSignature,
} from "./market-signature";
import { canonicalJson } from "./security";

const manifest: MarketMcpManifest = {
  schemaVersion: 1,
  identifier: "github",
  name: "GitHub",
  summary: "GitHub MCP",
  description: "GitHub MCP server",
  version: "1.0.0",
  categories: ["developer-tools"],
  transport: "streamable_http",
  endpointUrl: "https://mcp.example.com/mcp",
  auth: { required: false, type: "none", allowedHeaderNames: [] },
  tools: [],
  official: true,
  verified: true,
  desktopOnly: false,
  webExecutable: true,
  sourceUrl: "https://github.com/example/mcp",
};

function signingFixture(keyId = "sourceweft-test") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyBase64 = publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  const signature = sign(
    null,
    Buffer.from(canonicalJson(manifest)),
    privateKey,
  ).toString("base64");
  return {
    publicKeyEntry: `${keyId}:${publicKeyBase64}`,
    signature,
    signingKeyId: keyId,
  };
}

function assertMcpError(
  operation: () => unknown,
  code: string,
) {
  assert.throws(
    operation,
    (error) => error instanceof McpError && error.code === code,
  );
}

test("parseTrustedMarketPublicKeys ignores malformed entries", () => {
  assert.deepEqual(
    parseTrustedMarketPublicKeys(["bad", " key : public ", ":missing"]),
    [{ keyId: "key", publicKey: "public" }],
  );
});

test("verifyMarketManifestSignature accepts trusted valid signatures", () => {
  const fixture = signingFixture();

  const result = verifyMarketManifestSignature({
    manifest,
    signature: fixture.signature,
    signingKeyId: fixture.signingKeyId,
    trustedPublicKeys: [fixture.publicKeyEntry],
  });

  assert.equal(result.verified, true);
  assert.equal(result.signingKeyId, fixture.signingKeyId);
  assert.equal(result.manifestHash.length, 64);
});

test("verifyMarketManifestSignature allows unsigned manifests when no trusted keys are configured", () => {
  const result = verifyMarketManifestSignature({
    manifest,
    signature: null,
    signingKeyId: null,
    trustedPublicKeys: [],
  });

  assert.equal(result.signingKeyId, null);
});

test("verifyMarketManifestSignature rejects missing signatures when trusted keys are configured", () => {
  const fixture = signingFixture();

  assertMcpError(
    () =>
      verifyMarketManifestSignature({
        manifest,
        signature: null,
        signingKeyId: null,
        trustedPublicKeys: [fixture.publicKeyEntry],
      }),
    "MCP_MARKET_SIGNATURE_REQUIRED",
  );
});

test("verifyMarketManifestSignature rejects untrusted signing key ids", () => {
  const fixture = signingFixture();

  assertMcpError(
    () =>
      verifyMarketManifestSignature({
        manifest,
        signature: fixture.signature,
        signingKeyId: "unknown",
        trustedPublicKeys: [fixture.publicKeyEntry],
      }),
    "MCP_MARKET_SIGNING_KEY_UNTRUSTED",
  );
});

test("verifyMarketManifestSignature rejects modified manifests", () => {
  const fixture = signingFixture();

  assertMcpError(
    () =>
      verifyMarketManifestSignature({
        manifest: {
          ...manifest,
          endpointUrl: "https://evil.example.com/mcp",
        },
        signature: fixture.signature,
        signingKeyId: fixture.signingKeyId,
        trustedPublicKeys: [fixture.publicKeyEntry],
      }),
    "MCP_MARKET_SIGNATURE_INVALID",
  );
});

test("verifyMarketManifestSignature supports key rotation with multiple trusted keys", () => {
  const oldFixture = signingFixture("old-key");
  const newFixture = signingFixture("new-key");

  const result = verifyMarketManifestSignature({
    manifest,
    signature: newFixture.signature,
    signingKeyId: newFixture.signingKeyId,
    trustedPublicKeys: [oldFixture.publicKeyEntry, newFixture.publicKeyEntry],
  });

  assert.equal(result.signingKeyId, "new-key");
});
