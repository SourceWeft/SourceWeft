import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, teamDataKeys } from "@sourceweft/db";
import { config } from "./config";
import { decryptSecret, encryptPayloadWithKey, encryptSecret } from "./secrets";
import {
  clearTeamDataKeyCache,
  decryptTeamSecret,
  encryptTeamSecret,
  rotateTeamDataKey,
} from "./team-secrets";

const createdTeamIds: string[] = [];

function newTeamId() {
  const teamId = `team-secrets-test-${randomUUID()}`;
  createdTeamIds.push(teamId);
  return teamId;
}

afterEach(async () => {
  clearTeamDataKeyCache();
  if (createdTeamIds.length > 0) {
    await db
      .delete(teamDataKeys)
      .where(inArray(teamDataKeys.teamId, createdTeamIds));
    createdTeamIds.length = 0;
  }
});

test("team secret round-trips through a v2 payload", async () => {
  const teamId = newTeamId();

  const payload = await encryptTeamSecret("sk-super-secret", teamId);

  assert.ok(payload.startsWith("v2:"));
  assert.equal(payload.split(":").length, 4);
  assert.equal(await decryptTeamSecret(payload, teamId), "sk-super-secret");
});

test("empty and null inputs keep decryptSecret's empty semantics", async () => {
  const teamId = newTeamId();

  assert.equal(await encryptTeamSecret("", teamId), "");
  assert.equal(await decryptTeamSecret("", teamId), "");
  assert.equal(await decryptTeamSecret(null, teamId), "");
});

test("v1 payloads written with the master secret stay readable", async () => {
  const teamId = newTeamId();
  const v1Payload = encryptSecret(
    "legacy-token",
    config.modelGatewayEncryptionSecret,
  );

  assert.equal(await decryptTeamSecret(v1Payload, teamId), "legacy-token");

  // The v1 fallback never touches the team key, so no data-key row appears.
  const rows = await db
    .select()
    .from(teamDataKeys)
    .where(eq(teamDataKeys.teamId, teamId));
  assert.equal(rows.length, 0);
});

test("concurrent first encrypts converge on a single data-key row", async () => {
  const teamId = newTeamId();
  clearTeamDataKeyCache();

  const [first, second] = await Promise.all([
    encryptTeamSecret("first-secret", teamId),
    encryptTeamSecret("second-secret", teamId),
  ]);

  const rows = await db
    .select()
    .from(teamDataKeys)
    .where(eq(teamDataKeys.teamId, teamId));
  assert.equal(rows.length, 1);
  assert.equal(await decryptTeamSecret(first, teamId), "first-secret");
  assert.equal(await decryptTeamSecret(second, teamId), "second-secret");
});

test("a v2 payload does not decrypt under another team's key", async () => {
  const teamA = newTeamId();
  const teamB = newTeamId();

  const payload = await encryptTeamSecret("team-a-only", teamA);

  await assert.rejects(() => decryptTeamSecret(payload, teamB));
  // The owning team still decrypts fine afterwards.
  assert.equal(await decryptTeamSecret(payload, teamA), "team-a-only");
});

test("corrupt payloads fail with the same error shape as decryptSecret", async () => {
  const teamId = newTeamId();
  const expected = /Invalid encrypted secret payload/;

  // Unknown version prefix: identical behavior to decryptSecret.
  assert.throws(
    () =>
      decryptSecret("v9:aaaa:bbbb:cccc", config.modelGatewayEncryptionSecret),
    expected,
  );
  await assert.rejects(
    () => decryptTeamSecret("v9:aaaa:bbbb:cccc", teamId),
    expected,
  );

  // Missing segments and bad iv/tag lengths on a v2 payload.
  await assert.rejects(() => decryptTeamSecret("v2:only", teamId), expected);
  await assert.rejects(
    () => decryptTeamSecret("v2:aaaa:bbbb:cccc", teamId),
    expected,
  );
  await assert.rejects(
    () => decryptTeamSecret("not-a-payload", teamId),
    expected,
  );
});

test("encrypting requires a team id", async () => {
  await assert.rejects(
    () => encryptTeamSecret("secret", ""),
    /team id is required/,
  );
});

test("rotateTeamDataKey re-encrypts rows onto a new key and stamps rotated_at", async () => {
  const teamId = newTeamId();
  const preRotation = await encryptTeamSecret("rotate-me", teamId);
  const v1Payload = encryptSecret(
    "legacy-token",
    config.modelGatewayEncryptionSecret,
  );
  const [before] = await db
    .select()
    .from(teamDataKeys)
    .where(eq(teamDataKeys.teamId, teamId));
  assert.ok(before);
  assert.equal(before.rotatedAt, null);

  let migratedV2 = "";
  let migratedV1 = "";
  await rotateTeamDataKey(teamId, async (oldDecrypt, newEncrypt) => {
    migratedV2 = newEncrypt(oldDecrypt(preRotation));
    migratedV1 = newEncrypt(oldDecrypt(v1Payload));
    assert.equal(oldDecrypt(null), "");
    assert.equal(newEncrypt(""), "");
  });

  // Re-encrypted rows decrypt under the new current key.
  assert.equal(await decryptTeamSecret(migratedV2, teamId), "rotate-me");
  assert.equal(await decryptTeamSecret(migratedV1, teamId), "legacy-token");
  // The pre-rotation v2 payload stays readable through the retiring key
  // until the NEXT rotation replaces it.
  assert.equal(await decryptTeamSecret(preRotation, teamId), "rotate-me");
  // v1 payloads remain readable through the master-secret fallback.
  assert.equal(await decryptTeamSecret(v1Payload, teamId), "legacy-token");

  const [after] = await db
    .select()
    .from(teamDataKeys)
    .where(eq(teamDataKeys.teamId, teamId));
  assert.ok(after);
  assert.notEqual(after.wrappedKey, before.wrappedKey);
  // The old current key moved verbatim into the retiring slot.
  assert.equal(after.retiringWrappedKey, before.wrappedKey);
  assert.ok(after.rotatedAt instanceof Date);
});

test("a crash mid-re-encrypt loses no rows and a rerun finishes the job", async () => {
  const teamId = newTeamId();
  const untouched = await encryptTeamSecret("untouched-row", teamId);
  const reencryptMe = await encryptTeamSecret("reencrypt-me", teamId);
  const [before] = await db
    .select()
    .from(teamDataKeys)
    .where(eq(teamDataKeys.teamId, teamId));
  assert.ok(before);

  let migrated = "";
  await assert.rejects(
    () =>
      rotateTeamDataKey(teamId, async (oldDecrypt, newEncrypt) => {
        migrated = newEncrypt(oldDecrypt(reencryptMe));
        throw new Error("re-encrypt exploded");
      }),
    /re-encrypt exploded/,
  );

  // The new key was promoted before the callback ran: current is new, the
  // old current key sits in the retiring slot.
  const [after] = await db
    .select()
    .from(teamDataKeys)
    .where(eq(teamDataKeys.teamId, teamId));
  assert.ok(after);
  assert.notEqual(after.wrappedKey, before.wrappedKey);
  assert.equal(after.retiringWrappedKey, before.wrappedKey);
  assert.ok(after.rotatedAt instanceof Date);

  // Rows already re-encrypted read via the new current key; rows the crash
  // left behind read via the retiring key. Nothing is lost.
  assert.equal(await decryptTeamSecret(migrated, teamId), "reencrypt-me");
  assert.equal(await decryptTeamSecret(untouched, teamId), "untouched-row");

  // Rerunning the rotation picks up the stragglers: oldDecrypt covers the
  // whole pre-rerun key set, retiring key included.
  let recovered = "";
  await rotateTeamDataKey(teamId, async (oldDecrypt, newEncrypt) => {
    recovered = newEncrypt(oldDecrypt(untouched));
  });
  assert.equal(await decryptTeamSecret(recovered, teamId), "untouched-row");
});

test("a key fully retires only after two rotations", async () => {
  const teamId = newTeamId();
  const gen1 = await encryptTeamSecret("gen-1-secret", teamId);

  // First rotation with a no-op callback: the gen-1 row is deliberately not
  // re-encrypted, simulating a row the re-encrypt pass missed.
  await rotateTeamDataKey(teamId, async () => {});
  assert.equal(await decryptTeamSecret(gen1, teamId), "gen-1-secret");

  // Second rotation replaces the retiring slot; the gen-1 key is now gone
  // and the row fails GCM authentication under both remaining keys.
  await rotateTeamDataKey(teamId, async () => {});
  await assert.rejects(
    () => decryptTeamSecret(gen1, teamId),
    /Unsupported state or unable to authenticate data/,
  );
});

test("a stale-cache write under the old key stays readable after rotation", async () => {
  const teamId = newTeamId();
  await encryptTeamSecret("seed-the-key-row", teamId);
  const [row] = await db
    .select()
    .from(teamDataKeys)
    .where(eq(teamDataKeys.teamId, teamId));
  assert.ok(row);
  const oldRawKey = Buffer.from(
    decryptSecret(row.wrappedKey, config.modelGatewayEncryptionSecret),
    "base64",
  );

  await rotateTeamDataKey(teamId, async () => {});

  // Another process with a ≤5-minute-stale key cache writes a v2 row under
  // the old key AFTER the rotation committed. The retiring key decrypts it.
  const staleWrite = encryptPayloadWithKey(
    "stale-cache-write",
    oldRawKey,
    "v2",
  );
  assert.equal(
    await decryptTeamSecret(staleWrite, teamId),
    "stale-cache-write",
  );
});

test("decrypting a v2 payload for a keyless team fails without minting a key row", async () => {
  const teamWithKey = newTeamId();
  const keylessTeam = newTeamId();
  const payload = await encryptTeamSecret("not-yours", teamWithKey);

  await assert.rejects(
    () => decryptTeamSecret(payload, keylessTeam),
    new RegExp(
      `Team data key not found for team '${keylessTeam}' while decrypting a v2 payload`,
    ),
  );

  // The read path minted nothing: the keyless team still has no key row.
  const rows = await db
    .select()
    .from(teamDataKeys)
    .where(eq(teamDataKeys.teamId, keylessTeam));
  assert.equal(rows.length, 0);
});
