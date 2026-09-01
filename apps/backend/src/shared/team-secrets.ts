import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, teamDataKeys } from "@sourceweft/db";
import { config } from "./config";
import {
  decryptPayloadWithKey,
  decryptSecret,
  encryptPayloadWithKey,
  encryptSecret,
  parseSecretPayload,
} from "./secrets";

/**
 * Tenant envelope encryption for team-owned secrets (BYOK API keys, connector
 * OAuth tokens, workspace MCP credentials, ...).
 *
 * Each team has one current 32-byte data key, stored in `team_data_keys`
 * wrapped (encrypted) with the deployment master secret in the existing v1
 * payload format from `secrets.ts`, plus — after a rotation — one retiring
 * key: the previous current key, kept in `retiring_wrapped_key`. Tenant data
 * encrypted with the team's data key uses a `v2:iv:tag:ct` payload —
 * structurally identical to v1; the version prefix only says which key family
 * decrypts it. There is deliberately no key id inside the payload: decryption
 * tries the current key and falls back to the retiring key only when GCM
 * authentication fails, so rows still encrypted under the previous key (a
 * rotation that crashed mid-re-encrypt, or another process writing through a
 * ≤5-minute-stale key cache) stay readable until the next rotation replaces
 * the retiring key. Fully retiring a key therefore takes two consecutive
 * rotations — see {@link rotateTeamDataKey}.
 *
 * v1 payloads (encrypted directly with the master secret) stay readable
 * forever through {@link decryptTeamSecret}'s fallback, so rows written
 * before the envelope migration keep working without a backfill.
 *
 * Mixed-version deployments: code from before the envelope migration cannot
 * read `v2:` payloads, so api/worker/scheduler must be upgraded together —
 * the current single-instance compose topology keeps that window to seconds.
 */

const TEAM_PAYLOAD_PREFIX = "v2";
const DATA_KEY_BYTES = 32;
const DATA_KEY_CACHE_TTL_MS = 5 * 60 * 1000;

/** A team's unwrapped current key plus, after a rotation, the retiring one. */
type TeamKeySet = { current: Buffer; retiring: Buffer | null };

type CachedKeySet = { keys: TeamKeySet; expiresAt: number };

// Unwrapped data keys live only in process memory, never at rest.
const dataKeyCache = new Map<string, CachedKeySet>();

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

function cacheKeySet(teamId: string, keys: TeamKeySet) {
  dataKeyCache.set(teamId, {
    keys,
    expiresAt: Date.now() + DATA_KEY_CACHE_TTL_MS,
  });
}

function cachedKeySet(teamId: string) {
  const cached = dataKeyCache.get(teamId);
  return cached && cached.expiresAt > Date.now() ? cached.keys : null;
}

/** Drop cached unwrapped keys — for one team, or all of them. */
export function clearTeamDataKeyCache(teamId?: string) {
  if (teamId === undefined) {
    dataKeyCache.clear();
    return;
  }
  dataKeyCache.delete(teamId);
}

async function readKeyRow(teamId: string) {
  const [row] = await db
    .select({
      wrappedKey: teamDataKeys.wrappedKey,
      retiringWrappedKey: teamDataKeys.retiringWrappedKey,
    })
    .from(teamDataKeys)
    .where(eq(teamDataKeys.teamId, teamId))
    .limit(1);
  return row ?? null;
}

function unwrapKeyRow(row: {
  wrappedKey: string;
  retiringWrappedKey: string | null;
}): TeamKeySet {
  return {
    current: unwrapDataKey(row.wrappedKey),
    retiring: row.retiringWrappedKey
      ? unwrapDataKey(row.retiringWrappedKey)
      : null,
  };
}

/**
 * The team's key set for the encrypt path, with the current key created
 * lazily on first use. Creation is `INSERT ... ON CONFLICT DO NOTHING`
 * followed by a re-read, so concurrent first encrypts for the same team — in
 * this or any other process — converge on the single stored key instead of
 * double-writing. Decrypting must never mint a key; it goes through
 * {@link getTeamKeySetForDecrypt} instead.
 */
async function getOrCreateTeamKeySet(teamId: string): Promise<TeamKeySet> {
  requireTeamId(teamId);
  const cached = cachedKeySet(teamId);
  if (cached) {
    return cached;
  }

  let row = await readKeyRow(teamId);
  if (!row) {
    await db
      .insert(teamDataKeys)
      .values({ teamId, wrappedKey: wrapDataKey(randomBytes(DATA_KEY_BYTES)) })
      .onConflictDoNothing();
    // Re-read instead of trusting our own insert: on conflict the concurrent
    // winner's key is the team's key and ours was discarded.
    row = await readKeyRow(teamId);
  }
  if (!row) {
    throw new Error(`Team data key for team '${teamId}' could not be created`);
  }

  const keys = unwrapKeyRow(row);
  cacheKeySet(teamId, keys);
  return keys;
}

/**
 * The team's key set for decrypting an existing `v2:` payload — strictly
 * read-only. A `v2:` payload can only have been written by a team that
 * already has a key row, so a missing row is a hard error here, never a
 * reason to mint one.
 */
async function getTeamKeySetForDecrypt(teamId: string): Promise<TeamKeySet> {
  requireTeamId(teamId);
  const cached = cachedKeySet(teamId);
  if (cached) {
    return cached;
  }

  const row = await readKeyRow(teamId);
  if (!row) {
    throw new Error(
      `Team data key not found for team '${teamId}' while decrypting a v2 payload`,
    );
  }

  const keys = unwrapKeyRow(row);
  cacheKeySet(teamId, keys);
  return keys;
}

/**
 * Node throws this exact message when GCM authentication fails: the payload
 * is well-formed but was encrypted under a different key. Only that case may
 * fall back to the retiring key — anything else propagates untouched.
 */
function isGcmAuthFailure(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes("Unsupported state or unable to authenticate data")
  );
}

function decryptV2WithKeySet(cipherText: string, keys: TeamKeySet) {
  try {
    return decryptPayloadWithKey(cipherText, keys.current, TEAM_PAYLOAD_PREFIX);
  } catch (error) {
    if (keys.retiring && isGcmAuthFailure(error)) {
      return decryptPayloadWithKey(
        cipherText,
        keys.retiring,
        TEAM_PAYLOAD_PREFIX,
      );
    }
    throw error;
  }
}

function payloadVersion(cipherText: string) {
  const separator = cipherText.indexOf(":");
  return separator === -1 ? cipherText : cipherText.slice(0, separator);
}

/**
 * Encrypt a team-owned secret with the team's current data key into a `v2:`
 * payload. Empty input round-trips as an empty string, matching
 * `encryptSecret`.
 */
export async function encryptTeamSecret(plainText: string, teamId: string) {
  if (!plainText) {
    return "";
  }
  const keys = await getOrCreateTeamKeySet(teamId);
  return encryptPayloadWithKey(plainText, keys.current, TEAM_PAYLOAD_PREFIX);
}

/**
 * Decrypt a team-owned secret. `v2:` payloads decrypt with the team's current
 * data key, falling back to the retiring key only when GCM authentication
 * fails (the row was written under the pre-rotation key); anything else falls
 * back to {@link decryptSecret} with the deployment master secret — the
 * permanent read path for pre-envelope v1 rows, which also rejects unknown
 * versions with the same error shape. Decrypting never creates a key row: a
 * `v2:` payload for a team without one fails fast. Empty/null input returns
 * an empty string, matching `decryptSecret`.
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
  // Validate the payload shape before touching the database, so malformed
  // input fails identically whether or not the team has a key row.
  parseSecretPayload(cipherText, TEAM_PAYLOAD_PREFIX);
  return decryptV2WithKeySet(cipherText, await getTeamKeySetForDecrypt(teamId));
}

/**
 * Rotate a team's data key: atomically promote a fresh key to current —
 * moving the previous current key into the retiring slot and stamping
 * `rotated_at` in the same UPDATE — then hand the caller
 * `oldDecrypt`/`newEncrypt` to re-encrypt every one of the team's `v2:` rows.
 * `oldDecrypt` covers the whole pre-rotation key set (the previous current
 * key, the previous retiring key from an earlier rotation, and v1 payloads
 * via the master secret), so rerunning a rotation whose callback crashed
 * re-encrypts the stragglers instead of losing them.
 *
 * Promoting before re-encrypting removes the crash window: if the callback
 * dies midway, already-re-encrypted rows decrypt under the new current key
 * and untouched rows under the retiring key. The retiring key also keeps rows
 * readable when another process writes under the old key through a
 * ≤5-minute-stale key cache during or after the callback. On success the
 * retiring key is deliberately NOT cleared — it lives until the next rotation
 * replaces it, so fully retiring a key (e.g. after a suspected leak) takes
 * two consecutive rotations, and whatever sat in the retiring slot before
 * this rotation stops decrypting the moment it runs. Concurrent rotations of
 * the same team are not supported.
 */
export async function rotateTeamDataKey(
  teamId: string,
  reencrypt: (
    oldDecrypt: (cipherText: string | null) => string,
    newEncrypt: (plainText: string) => string,
  ) => Promise<void>,
): Promise<void> {
  requireTeamId(teamId);
  // Rotate from the stored key set, not a possibly stale cache entry.
  clearTeamDataKeyCache(teamId);
  const previousKeys = await getOrCreateTeamKeySet(teamId);
  const newKey = randomBytes(DATA_KEY_BYTES);

  // Atomic promotion: the new key becomes current and the stored current key
  // becomes retiring in one UPDATE, so no intermediate state ever drops a key
  // that live rows still need.
  const updated = await db
    .update(teamDataKeys)
    .set({
      wrappedKey: wrapDataKey(newKey),
      retiringWrappedKey: sql`${teamDataKeys.wrappedKey}`,
      rotatedAt: new Date(),
    })
    .where(eq(teamDataKeys.teamId, teamId))
    .returning({ teamId: teamDataKeys.teamId });
  if (updated.length === 0) {
    throw new Error(
      `Team data key for team '${teamId}' disappeared during rotation`,
    );
  }
  // Replace this process's cached set immediately so concurrent encrypts in
  // this process use the new key while the callback runs.
  cacheKeySet(teamId, { current: newKey, retiring: previousKeys.current });

  const oldDecrypt = (cipherText: string | null) => {
    if (!cipherText) {
      return "";
    }
    if (payloadVersion(cipherText) !== TEAM_PAYLOAD_PREFIX) {
      return decryptSecret(cipherText, masterSecret());
    }
    return decryptV2WithKeySet(cipherText, previousKeys);
  };
  const newEncrypt = (plainText: string) =>
    plainText
      ? encryptPayloadWithKey(plainText, newKey, TEAM_PAYLOAD_PREFIX)
      : "";

  await reencrypt(oldDecrypt, newEncrypt);
}
