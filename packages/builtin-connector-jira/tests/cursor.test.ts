import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { AtlassianApiError } from "@sourceweft/atlassian-client";
import { decodeSiteCursor, encodeSiteCursor } from "../src/cursor";

function cloudId(n: number): string {
  return `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;
}

const CLOUD_A = cloudId(1);
const CLOUD_B = cloudId(2);
const CLOUD_C = cloudId(3);

function isInvalid(error: unknown): boolean {
  return (
    error instanceof AtlassianApiError &&
    error.statusCode === 400 &&
    error.code === "JIRA_INVALID_REQUEST"
  );
}

test("encode then decode round-trips the per-site tokens", () => {
  const sites = { [CLOUD_A]: "token-a", [CLOUD_B]: null };
  const encoded = encodeSiteCursor(sites);
  assert.equal(typeof encoded, "string");
  // base64url: no padding, no `+`/`/`.
  assert.ok(!/[+/=]/.test(encoded));
  assert.deepEqual(decodeSiteCursor(encoded, [CLOUD_A, CLOUD_B]), sites);
});

test("decode rejects a value that is not a string", () => {
  assert.throws(() => decodeSiteCursor(42, [CLOUD_A]), isInvalid);
  assert.throws(() => decodeSiteCursor(null, [CLOUD_A]), isInvalid);
  assert.throws(() => decodeSiteCursor(undefined, [CLOUD_A]), isInvalid);
});

test("decode rejects a value that is not base64url JSON", () => {
  assert.throws(() => decodeSiteCursor("not-base64-!!!", [CLOUD_A]), isInvalid);
});

test("decode rejects a wrong version", () => {
  const encoded = Buffer.from(
    JSON.stringify({ v: 2, sites: { [CLOUD_A]: null } }),
    "utf8",
  ).toString("base64url");
  assert.throws(() => decodeSiteCursor(encoded, [CLOUD_A]), isInvalid);
});

test("decode rejects a site outside the selection", () => {
  const encoded = encodeSiteCursor({ [CLOUD_C]: "token-c" });
  assert.throws(() => decodeSiteCursor(encoded, [CLOUD_A, CLOUD_B]), isInvalid);
});

test("decode rejects a cursor longer than 4096 characters", () => {
  const encoded = "a".repeat(5000);
  assert.throws(() => decodeSiteCursor(encoded, [CLOUD_A]), isInvalid);
});

test("decode rejects a token that is neither a string nor null", () => {
  const encoded = Buffer.from(
    JSON.stringify({ v: 1, sites: { [CLOUD_A]: 7 } }),
    "utf8",
  ).toString("base64url");
  assert.throws(() => decodeSiteCursor(encoded, [CLOUD_A]), isInvalid);
});

test("decode rejects a `sites` field that is not an object", () => {
  const encoded = Buffer.from(
    JSON.stringify({ v: 1, sites: [CLOUD_A] }),
    "utf8",
  ).toString("base64url");
  assert.throws(() => decodeSiteCursor(encoded, [CLOUD_A]), isInvalid);
});
