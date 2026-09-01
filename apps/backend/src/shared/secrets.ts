import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/**
 * Deployment-level secret encryption: AES-256-GCM keyed by the deployment
 * master secret, `v1:iv:tag:ct` payloads. Use this only for deployment-owned
 * ciphertexts (e.g. model-gateway global provider keys). Team-owned secrets
 * (BYOK keys, connector OAuth tokens, workspace MCP credentials, ...) are
 * envelope-encrypted per tenant — encrypt/decrypt those through
 * `team-secrets.ts`, whose `decryptTeamSecret` still reads these v1 payloads.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const PAYLOAD_PREFIX = "v1";

function deriveKey(secret: string) {
  return createHash("sha256").update(secret).digest();
}

/**
 * Keyed `prefix:iv:tag:ct` GCM payload primitives. Internal to `secrets.ts`
 * and `team-secrets.ts` — every other caller goes through
 * `encryptSecret`/`decryptSecret` or the team-secrets envelope, which choose
 * the key and version prefix.
 */
export function parseSecretPayload(cipherText: string, expectedPrefix: string) {
  const [version, ivB64, authTagB64, encryptedB64] = cipherText.split(":");
  if (version !== expectedPrefix || !ivB64 || !authTagB64 || !encryptedB64) {
    throw new Error("Invalid encrypted secret payload");
  }

  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const encrypted = Buffer.from(encryptedB64, "base64");

  if (iv.byteLength !== IV_BYTES || authTag.byteLength !== AUTH_TAG_BYTES) {
    throw new Error("Invalid encrypted secret payload");
  }

  return { iv, authTag, encrypted };
}

/** See {@link parseSecretPayload} — internal to secrets.ts/team-secrets.ts. */
export function encryptPayloadWithKey(
  plainText: string,
  key: Buffer,
  prefix: string,
) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    prefix,
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

/** See {@link parseSecretPayload} — internal to secrets.ts/team-secrets.ts. */
export function decryptPayloadWithKey(
  cipherText: string,
  key: Buffer,
  expectedPrefix: string,
) {
  const { iv, authTag, encrypted } = parseSecretPayload(
    cipherText,
    expectedPrefix,
  );

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

export function encryptSecret(plainText: string, secret: string) {
  if (!plainText) {
    return "";
  }
  return encryptPayloadWithKey(plainText, deriveKey(secret), PAYLOAD_PREFIX);
}

export function decryptSecret(cipherText: string | null, secret: string) {
  if (!cipherText) {
    return "";
  }
  return decryptPayloadWithKey(cipherText, deriveKey(secret), PAYLOAD_PREFIX);
}
