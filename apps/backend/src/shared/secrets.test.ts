import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import {
  decryptPayloadWithKey,
  decryptSecret,
  encryptPayloadWithKey,
  encryptSecret,
  parseSecretPayload,
} from "./secrets";

// Ciphertexts produced by the implementation BEFORE the shared keyed
// primitives were extracted (commit a5fa24a era). They pin the wire format:
// if either fixture stops decrypting, the refactor broke byte-level
// compatibility with rows already at rest.
const FIXTURE_SECRET = "team-secrets-fixture-master-secret";
const FIXTURE_PLAINTEXT = "fixture-plaintext-sk-12345";
const V1_FIXTURE =
  "v1:8EJxCeszhLQk29QV:83n1dWtbDRO0v2AcftT6tg==:hF0XlzJHQXCOaJUvxOlKIP8lpOT6pMchPJw=";
const V2_FIXTURE =
  "v2:3uoQcu/vzn/SPSgn:YV/gvlsVwF9kOPoFvrHkew==:cPp8XAqmnU8U8rtdpXwL26r/1jtyKUKjb6s=";
// The fixed 32-byte data key the v2 fixture was encrypted under.
const V2_FIXTURE_KEY = createHash("sha256")
  .update("team-secrets-fixture-raw-key")
  .digest();

test("pre-refactor v1 ciphertext still decrypts byte-for-byte", () => {
  assert.equal(decryptSecret(V1_FIXTURE, FIXTURE_SECRET), FIXTURE_PLAINTEXT);
});

test("pre-refactor v2 ciphertext still decrypts through the shared primitive", () => {
  assert.equal(
    decryptPayloadWithKey(V2_FIXTURE, V2_FIXTURE_KEY, "v2"),
    FIXTURE_PLAINTEXT,
  );
});

test("v1 round-trips through encryptSecret/decryptSecret", () => {
  const payload = encryptSecret("round-trip-me", FIXTURE_SECRET);
  assert.ok(payload.startsWith("v1:"));
  assert.equal(payload.split(":").length, 4);
  assert.equal(decryptSecret(payload, FIXTURE_SECRET), "round-trip-me");
});

test("keyed primitives round-trip under an arbitrary prefix", () => {
  const payload = encryptPayloadWithKey("primitive-trip", V2_FIXTURE_KEY, "v2");
  assert.ok(payload.startsWith("v2:"));
  assert.equal(
    decryptPayloadWithKey(payload, V2_FIXTURE_KEY, "v2"),
    "primitive-trip",
  );
});

test("empty inputs keep their empty-string semantics", () => {
  assert.equal(encryptSecret("", FIXTURE_SECRET), "");
  assert.equal(decryptSecret("", FIXTURE_SECRET), "");
  assert.equal(decryptSecret(null, FIXTURE_SECRET), "");
});

test("malformed payloads fail with the unchanged error string", () => {
  const expected = /Invalid encrypted secret payload/;

  // Wrong or unknown version prefix.
  assert.throws(() => decryptSecret(V2_FIXTURE, FIXTURE_SECRET), expected);
  assert.throws(
    () => decryptSecret("v9:aaaa:bbbb:cccc", FIXTURE_SECRET),
    expected,
  );
  // Missing segments and bad iv/tag lengths.
  assert.throws(() => decryptSecret("v1:only", FIXTURE_SECRET), expected);
  assert.throws(
    () => decryptSecret("v1:aaaa:bbbb:cccc", FIXTURE_SECRET),
    expected,
  );
  assert.throws(() => decryptSecret("not-a-payload", FIXTURE_SECRET), expected);
  // The shared parser enforces the same shape for any prefix.
  assert.throws(() => parseSecretPayload("v2:only", "v2"), expected);
  assert.throws(() => parseSecretPayload(V2_FIXTURE, "v1"), expected);
});

test("a wrong key or tampered ciphertext fails GCM authentication, not parsing", () => {
  const expected = /Unsupported state or unable to authenticate data/;

  assert.throws(() => decryptSecret(V1_FIXTURE, "the-wrong-secret"), expected);

  const segments = V1_FIXTURE.split(":");
  const ct = Buffer.from(segments[3]!, "base64");
  ct[0] = ct[0]! ^ 0xff;
  const tampered = [
    segments[0],
    segments[1],
    segments[2],
    ct.toString("base64"),
  ].join(":");
  assert.throws(() => decryptSecret(tampered, FIXTURE_SECRET), expected);
});
