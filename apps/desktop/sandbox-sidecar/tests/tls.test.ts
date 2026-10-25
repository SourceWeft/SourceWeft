import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateCa, validateCaPair } from "@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-ca.js";
import { ensureCa, MIN_CA_REMAINING_DAYS } from "../src/tls.js";

const mode = (path: string): number => statSync(path).mode & 0o777;
const freshDir = (): string => join(mkdtempSync(join(tmpdir(), "srt-sidecar-ca-")), "ca");

test("ensureCa creates a valid CA pair in a private directory with tight modes", async () => {
  const caDir = freshDir();
  const ca = await ensureCa(caDir);
  assert.equal(ca.certPath, join(caDir, "ca.crt"));
  assert.equal(ca.keyPath, join(caDir, "ca.key"));
  assert.equal(ca.regenerated, true);
  assert.equal(mode(caDir), 0o700);
  assert.equal(mode(ca.keyPath), 0o600);
  assert.equal(mode(ca.certPath), 0o644);
  const check = validateCaPair(readFileSync(ca.certPath, "utf8"), readFileSync(ca.keyPath, "utf8"));
  assert.ok(check.ok);
  if (check.ok) assert.equal(check.thumbprint, ca.thumbprint);
  assert.ok(ca.notAfter.getTime() > Date.now() + MIN_CA_REMAINING_DAYS * 86_400_000);
});

test("ensureCa reuses a valid persistent CA", async () => {
  const caDir = freshDir();
  const first = await ensureCa(caDir);
  const second = await ensureCa(caDir);
  assert.equal(second.regenerated, false);
  assert.equal(second.thumbprint, first.thumbprint);
});

test("ensureCa regenerates when the key is corrupt, the cert is missing, or the pair mismatches", async () => {
  const caDir = freshDir();
  const first = await ensureCa(caDir);

  writeFileSync(first.keyPath, "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----\n");
  const afterCorrupt = await ensureCa(caDir);
  assert.equal(afterCorrupt.regenerated, true);
  assert.notEqual(afterCorrupt.thumbprint, first.thumbprint);
  assert.ok(validateCaPair(readFileSync(afterCorrupt.certPath, "utf8"), readFileSync(afterCorrupt.keyPath, "utf8")).ok);

  writeFileSync(afterCorrupt.certPath, "");
  const afterEmpty = await ensureCa(caDir);
  assert.equal(afterEmpty.regenerated, true);

  // A certificate from one CA with the key of another.
  const other = generateCa();
  writeFileSync(afterEmpty.certPath, other.certPem);
  const afterMismatch = await ensureCa(caDir);
  assert.equal(afterMismatch.regenerated, true);
  assert.notEqual(afterMismatch.thumbprint, afterEmpty.thumbprint);
  assert.ok(validateCaPair(readFileSync(afterMismatch.certPath, "utf8"), readFileSync(afterMismatch.keyPath, "utf8")).ok);
});

test("ensureCa rotates a CA with less than 30 days left, but not one with more", async () => {
  const soon = freshDir();
  const first = await ensureCa(soon);
  // Pretend it is 20 days before expiry.
  const nearExpiry = new Date(first.notAfter.getTime() - 20 * 86_400_000);
  const rotated = await ensureCa(soon, { now: () => nearExpiry });
  assert.equal(rotated.regenerated, true);
  assert.notEqual(rotated.thumbprint, first.thumbprint);

  const later = new Date(rotated.notAfter.getTime() - 40 * 86_400_000);
  const kept = await ensureCa(soon, { now: () => later });
  assert.equal(kept.regenerated, false);
  assert.equal(kept.thumbprint, rotated.thumbprint);
});

test("ensureCa tightens loose permissions on an existing CA without regenerating it", async () => {
  const caDir = freshDir();
  const first = await ensureCa(caDir);
  chmodSync(first.keyPath, 0o666);
  chmodSync(first.certPath, 0o600);
  chmodSync(caDir, 0o755);
  const again = await ensureCa(caDir);
  assert.equal(again.regenerated, false);
  assert.equal(again.thumbprint, first.thumbprint);
  assert.equal(mode(first.keyPath), 0o600);
  assert.equal(mode(first.certPath), 0o644);
  assert.equal(mode(caDir), 0o700);
});

test("ensureCa never leaves temporary files behind", async () => {
  const caDir = freshDir();
  await ensureCa(caDir);
  const { readdirSync } = await import("node:fs");
  assert.deepEqual(readdirSync(caDir).sort(), ["ca.crt", "ca.key"]);
});
