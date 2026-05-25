import { createPublicKey, verify } from "node:crypto";
import type { MarketMcpManifest } from "@sourceweft/market-sdk";
import { McpError } from "./errors";
import { canonicalJson, hashJson } from "./security";

export type TrustedMarketPublicKey = {
  keyId: string;
  publicKey: string;
};

function decodeBase64(value: string) {
  try {
    return Buffer.from(value, "base64");
  } catch {
    throw new McpError(
      422,
      "MCP_MARKET_SIGNATURE_INVALID",
      "MCP market signature or public key is not valid base64",
    );
  }
}

export function parseTrustedMarketPublicKeys(
  values: readonly string[],
): TrustedMarketPublicKey[] {
  return values.flatMap((value) => {
    const separatorIndex = value.indexOf(":");
    if (separatorIndex <= 0) {
      return [];
    }
    const keyId = value.slice(0, separatorIndex).trim();
    const publicKey = value.slice(separatorIndex + 1).trim();
    return keyId && publicKey ? [{ keyId, publicKey }] : [];
  });
}

export function createEd25519PublicKey(value: string) {
  const bytes = decodeBase64(value);
  const der =
    bytes.length === 32
      ? Buffer.concat([
          Buffer.from("302a300506032b6570032100", "hex"),
          bytes,
        ])
      : bytes;
  try {
    return createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new McpError(
      422,
      "MCP_MARKET_PUBLIC_KEY_INVALID",
      "MCP market signing public key is invalid",
    );
  }
}

export function verifyMarketManifestSignature(input: {
  manifest: MarketMcpManifest;
  signature?: string | null;
  signingKeyId?: string | null;
  trustedPublicKeys: readonly string[];
}) {
  const trustedPublicKeys = parseTrustedMarketPublicKeys(input.trustedPublicKeys);
  if (trustedPublicKeys.length > 0) {
    if (!input.signature || !input.signingKeyId) {
      throw new McpError(
        422,
        "MCP_MARKET_SIGNATURE_REQUIRED",
        "MCP manifests must include a signature and signing key id when trusted market keys are configured",
      );
    }
    const key = trustedPublicKeys.find(
      (candidate) => candidate.keyId === input.signingKeyId,
    );
    if (!key) {
      throw new McpError(
        422,
        "MCP_MARKET_SIGNING_KEY_UNTRUSTED",
        "MCP manifest signing key is not trusted by this SourceWeft deployment",
      );
    }
    const valid = verify(
      null,
      Buffer.from(canonicalJson(input.manifest)),
      createEd25519PublicKey(key.publicKey),
      decodeBase64(input.signature),
    );
    if (!valid) {
      throw new McpError(
        422,
        "MCP_MARKET_SIGNATURE_INVALID",
        "MCP manifest signature is invalid",
      );
    }
  }
  return {
    verified: input.manifest.verified,
    signingKeyId: input.signingKeyId ?? null,
    manifestHash: hashJson(input.manifest),
  };
}
