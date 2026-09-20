import test from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// Generate test-only Minisign fixtures. Production verification is exclusively
// the same minisign-verify library used by Tauri, not this fixture generator.
function fixture(bytes) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = randomBytes(8);
  const rawKey = publicKey
    .export({ type: "spki", format: "der" })
    .subarray(-32);
  const key = Buffer.from(
    `untrusted comment: test public key\n${Buffer.concat([Buffer.from("Ed"), keyId, rawKey]).toString("base64")}\n`,
  ).toString("base64");
  const signature = sign(
    null,
    createHash("blake2b512").update(bytes).digest(),
    privateKey,
  );
  const comment = "test update";
  const global = sign(
    null,
    Buffer.concat([signature, Buffer.from(comment)]),
    privateKey,
  );
  const packet = Buffer.concat([Buffer.from("ED"), keyId, signature]).toString(
    "base64",
  );
  return {
    key,
    signature: Buffer.from(
      `untrusted comment: test\n${packet}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`,
    ).toString("base64"),
  };
}
test("real Tauri-compatible verifier accepts authentic bytes and rejects tampering and another key", async (t) => {
  assert(
    process.env.DESKTOP_UPDATE_VERIFIER,
    "Build update-verifier and set DESKTOP_UPDATE_VERIFIER before this integration test",
  );
  const dir = await mkdtemp(join(tmpdir(), "update-signature-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from("test update bytes");
  const signed = fixture(bytes);
  const path = join(dir, "update");
  const sig = `${path}.sig`;
  await writeFile(path, bytes);
  await writeFile(sig, signed.signature);
  const verify = (key) =>
    spawnSync(process.env.DESKTOP_UPDATE_VERIFIER, [path, sig], {
      env: { ...process.env, TAURI_UPDATER_PUBLIC_KEY: key },
      encoding: "utf8",
    });
  assert.equal(verify(signed.key).status, 0);
  assert.notEqual(verify(fixture(bytes).key).status, 0);
  await writeFile(path, "tampered");
  assert.notEqual(verify(signed.key).status, 0);
  await writeFile(sig, "bad-base64");
  assert.notEqual(verify(signed.key).status, 0);
});
