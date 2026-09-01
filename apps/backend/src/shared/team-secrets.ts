import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, teamDataKeys } from "@sourceweft/db";
import { config } from "./config";
import { decryptSecret, encryptSecret } from "./secrets";

/**
 * Tenant envelope encryption for team-owned secrets (BYOK API keys, connector
 * OAuth tokens, workspace MCP credentials, ...).
 *
 * Each team has exactly one current 32-byte data key, stored in
 * `team_data_keys` wrapped (encrypted) with the deployment master secret in
 * the existing v1 payload format from `secrets.ts`. Tenant data encrypted
 * with the team's data key uses a `v2:iv:tag:ct` payload — structurally
 * identical to v1; the version prefix only says which key decrypts it. There
 * is deliberately no key id inside the payload: rotation re-encrypts every
 * one of the team's rows under the new key (see {@link rotateTeamDataKey}),
 * so at most one team key is ever live.
 *
 * v1 payloads (encrypted directly with the master secret) stay readable
 * forever through {@link decryptTeamSecret}'s fallback, so rows written
 * before the envelope migration keep working without a backfill.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const TEAM_PAYLOAD_PREFIX = "v2";
const DATA_KEY_BYTES = 32;
const DATA_KEY_CACHE_TTL_MS = 5 * 60 * 1000;

type CachedDataKey = { key: Buffer; expiresAt: number };

// Unwrapped data keys live only in process memory, never at rest.
const dataKeyCache = new Map<string, CachedDataKey>();

function masterSecret() {
  return config.modelGatewayEncryptionSecret;
}

function requireTeamId(teamId: string) {
  if (!teamId) {
    throw new Error("A team id is required to resolve a team data key");
  }
  return teamId;
}

function wrapDataKey(rawKey: Buffer) {
  return encryptSecret(rawKey.toString("base64"), masterSecret());
}

function unwrapDataKey(wrappedKey: string) {
  const rawKey = Buffer.from(
    decryptSecret(wrappedKey, masterSecret()),
    "base64",
  );
  if (rawKey.byteLength !== DATA_KEY_BYTES) {
    throw new Error("Invalid team data key");
  }
  return rawKey;
}

function cacheDataKey(teamId: string, key: Buffer) {
  dataKeyCache.set(teamId, {
    key,
    expiresAt: Date.now() + DATA_KEY_CACHE_TTL_MS,
  });
}

/** Drop cached unwrapped keys — for one team, or all of them. */
export function clearTeamDataKeyCache(teamId?: string) {
  if (teamId === undefined) {
    dataKeyCache.clear();
    return;
  }
  dataKeyCache.delete(teamId);
}

async function readWrappedKey(teamId: string) {
  const [row] = await db
    .select({ wrappedKey: teamDataKeys.wrappedKey })
    .from(teamDataKeys)
    .where(eq(teamDataKeys.teamId, teamId))
    .limit(1);
  return row?.wrappedKey ?? null;
}

/**
 * The team's current data key, created lazily on first use. Creation is
 * `INSERT ... ON CONFLICT DO NOTHING` followed by a re-read, so concurrent
 * first encrypts for the same team — in this or any other process — converge
 * on the single stored key instead of double-writing.
 */
async function getTeamDataKey(teamId: string): Promise<Buffer> {
  requireTeamId(teamId);
  const cached = dataKeyCache.get(teamId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.key;
  }

  let wrappedKey = await readWrappedKey(teamId);
  if (!wrappedKey) {
    await db
      .insert(teamDataKeys)
      .values({ teamId, wrappedKey: wrapDataKey(randomBytes(DATA_KEY_BYTES)) })
      .onConflictDoNothing();
    // Re-read instead of trusting our own insert: on conflict the concurrent
    // winner's key is the team's key and ours was discarded.
    wrappedKey = await readWrappedKey(teamId);
  }
  if (!wrappedKey) {
    throw new Error(`Team data key for team '${teamId}' could not be created`);
  }

  const key = unwrapDataKey(wrappedKey);
  cacheDataKey(teamId, key);
  return key;
}

function encryptWithDataKey(plainText: string, key: Buffer) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final(),
  ]);

  return [
    TEAM_PAYLOAD_PREFIX,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

function decryptWithDataKey(cipherText: string, key: Buffer) {
  const [, ivB64, authTagB64, encryptedB64] = cipherText.split(":");
  if (!ivB64 || !authTagB64 || !encryptedB64) {
    throw new Error("Invalid encrypted secret payload");
  }

  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  if (iv.byteLength !== IV_BYTES || authTag.byteLength !== AUTH_TAG_BYTES) {
    throw new Error("Invalid encrypted secret payload");
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function payloadVersion(cipherText: string) {
  const separator = cipherText.indexOf(":");
  return separator === -1 ? cipherText : cipherText.slice(0, separator);
}

/**
 * Encrypt a team-owned secret with the team's data key into a `v2:` payload.
 * Empty input round-trips as an empty string, matching `encryptSecret`.
 */
export async function encryptTeamSecret(plainText: string, teamId: string) {
  if (!plainText) {
    return "";
  }
  return encryptWithDataKey(plainText, await getTeamDataKey(teamId));
}

/**
 * Decrypt a team-owned secret. `v2:` payloads decrypt with the team's data
 * key; anything else falls back to {@link decryptSecret} with the deployment
 * master secret — the permanent read path for pre-envelope v1 rows, which
 * also rejects unknown versions with the same error shape. Empty/null input
 * returns an empty string, matching `decryptSecret`.
 */
export async function decryptTeamSecret(
  cipherText: string | null,
  teamId: string,
) {
  if (!cipherText) {
    return "";
  }
  if (payloadVersion(cipherText) !== TEAM_PAYLOAD_PREFIX) {
    return decryptSecret(cipherText, masterSecret());
  }
  return decryptWithDataKey(cipherText, await getTeamDataKey(teamId));
}

/**
 * Rotate a team's data key. Generates the new key, hands the caller
 * `oldDecrypt`/`newEncrypt` to re-encrypt every one of the team's `v2:` rows
 * (v1 rows also decrypt through `oldDecrypt`), and only after the callback
 * succeeds atomically replaces `wrapped_key` and stamps `rotated_at`. If the
 * callback throws, the stored key is untouched and existing rows keep
 * decrypting.
 *
 * Payloads carry no key id, so a concurrent `encryptTeamSecret` in another
 * process during the callback window can still write under the old key;
 * rotation is expected to run without concurrent writers for the team.
 */
export async function rotateTeamDataKey(
  teamId: string,
  reencrypt: (
    oldDecrypt: (cipherText: string | null) => string,
    newEncrypt: (plainText: string) => string,
  ) => Promise<void>,
): Promise<void> {
  requireTeamId(teamId);
  // Rotate from the stored key, not a possibly stale cache entry.
  clearTeamDataKeyCache(teamId);
  const oldKey = await getTeamDataKey(teamId);
  const newKey = randomBytes(DATA_KEY_BYTES);

  const oldDecrypt = (cipherText: string | null) => {
    if (!cipherText) {
      return "";
    }
    if (payloadVersion(cipherText) !== TEAM_PAYLOAD_PREFIX) {
      return decryptSecret(cipherText, masterSecret());
    }
    return decryptWithDataKey(cipherText, oldKey);
  };
  const newEncrypt = (plainText: string) =>
    plainText ? encryptWithDataKey(plainText, newKey) : "";

  await reencrypt(oldDecrypt, newEncrypt);

  const updated = await db
    .update(teamDataKeys)
    .set({ wrappedKey: wrapDataKey(newKey), rotatedAt: new Date() })
    .where(eq(teamDataKeys.teamId, teamId))
    .returning({ teamId: teamDataKeys.teamId });
  if (updated.length === 0) {
    throw new Error(
      `Team data key for team '${teamId}' disappeared during rotation`,
    );
  }
  cacheDataKey(teamId, newKey);
}
