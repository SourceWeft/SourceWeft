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

export type MarketManifestVerification = {
  /** True only when a trusted signature was actually verified. */
  signatureVerified: boolean;
  /**
   * The trust badge to persist/show. Never derived from the manifest's own
   * self-asserted `verified` flag — only a verified signature can set this.
   */
  verified: boolean;
  signingKeyId: string | null;
  manifestHash: string;
};

type MarketSignatureEnvelope = {
  identifier: string;
  version: string;
  manifestHash: string;
  notAfter: string | null;
};

/**
 * Return the signed envelope object if `value` carries the expected fields, or
 * null for legacy (manifest-only) signatures. The ORIGINAL object is returned
 * so its exact canonical form — the bytes that were signed — is reconstructed.
 */
function asSignatureEnvelope(value: unknown): MarketSignatureEnvelope | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.identifier === "string" &&
    typeof candidate.version === "string" &&
    typeof candidate.manifestHash === "string"
  ) {
    return value as MarketSignatureEnvelope;
  }
  return null;
}

export function verifyMarketManifestSignature(input: {
  manifest: MarketMcpManifest;
  signature?: string | null;
  signingKeyId?: string | null;
  trustedPublicKeys: readonly string[];
  /** When no trusted keys are configured, allow the install to proceed unsigned. */
  allowUnsigned?: boolean;
  /** The signed envelope shipped in the version's provenanceJson, if any. */
  envelope?: unknown;
  /** Injectable clock for expiry checks. */
  now?: Date;
}): MarketManifestVerification {
  const trustedPublicKeys = parseTrustedMarketPublicKeys(input.trustedPublicKeys);
  if (trustedPublicKeys.length === 0) {
    if (!input.allowUnsigned) {
      throw new McpError(
        503,
        "MCP_MARKET_SIGNING_NOT_CONFIGURED",
        "MCP market signature verification is not configured. Set MARKET_TRUSTED_PUBLIC_KEYS or explicitly allow unsigned installs.",
      );
    }
    // Degraded (opt-in) mode: proceed but never claim the manifest is verified.
    return {
      signatureVerified: false,
      verified: false,
      signingKeyId: input.signingKeyId ?? null,
      manifestHash: hashJson(input.manifest),
    };
  }

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
  const publicKey = createEd25519PublicKey(key.publicKey);
  const manifestHash = hashJson(input.manifest);

  const envelope = asSignatureEnvelope(input.envelope);
  if (envelope) {
    // Envelope path: the signature covers the envelope, which binds
    // identifier + version + manifestHash (+ optional expiry).
    const valid = verify(
      null,
      Buffer.from(canonicalJson(input.envelope)),
      publicKey,
      decodeBase64(input.signature),
    );
    if (!valid) {
      throw new McpError(
        422,
        "MCP_MARKET_SIGNATURE_INVALID",
        "MCP manifest signature is invalid",
      );
    }
    if (
      envelope.manifestHash !== manifestHash ||
      envelope.identifier !== input.manifest.identifier ||
      envelope.version !== input.manifest.version
    ) {
      throw new McpError(
        422,
        "MCP_MARKET_SIGNATURE_INVALID",
        "MCP manifest does not match its signed envelope (identifier, version, or content mismatch)",
      );
    }
    if (envelope.notAfter) {
      const now = input.now ?? new Date();
      const expiry = Date.parse(envelope.notAfter);
      if (Number.isFinite(expiry) && now.getTime() > expiry) {
        throw new McpError(
          422,
          "MCP_MARKET_SIGNATURE_EXPIRED",
          "MCP manifest signature has expired",
        );
      }
    }
    return {
      signatureVerified: true,
      verified: true,
      signingKeyId: input.signingKeyId,
      manifestHash,
    };
  }

  // Legacy path: the signature covers the bare manifest.
  const valid = verify(
    null,
    Buffer.from(canonicalJson(input.manifest)),
    publicKey,
    decodeBase64(input.signature),
  );
  if (!valid) {
    throw new McpError(
      422,
      "MCP_MARKET_SIGNATURE_INVALID",
      "MCP manifest signature is invalid",
    );
  }
  return {
    signatureVerified: true,
    verified: true,
    signingKeyId: input.signingKeyId,
    manifestHash,
  };
}
