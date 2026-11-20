import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { AtlassianApiError } from "../src/errors";
import { decodeSiteCursor, encodeSiteCursor } from "../src/site-cursor";

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
    error.code === "JIRA_INVALID_REQUEST" &&
    error.message === "Invalid Jira cursor"
  );
}

function raw(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

test("encode then decode round-trips the per-site tokens", () => {
  const sites = { [CLOUD_A]: "token-a", [CLOUD_B]: null };
  const encoded = encodeSiteCursor(sites);
  assert.equal(typeof encoded, "string");
  // base64url: no padding, no `+`/`/`.
  assert.ok(!/[+/=]/.test(encoded));
  assert.deepEqual(decodeSiteCursor(encoded, [CLOUD_A, CLOUD_B], "JIRA"), sites);
});

test("decode rejects a value that is not a string", () => {
  assert.throws(() => decodeSiteCursor(42, [CLOUD_A], "JIRA"), isInvalid);
  assert.throws(() => decodeSiteCursor(null, [CLOUD_A], "JIRA"), isInvalid);
  assert.throws(() => decodeSiteCursor(undefined, [CLOUD_A], "JIRA"), isInvalid);
});

test("decode rejects an empty string", () => {
  assert.throws(() => decodeSiteCursor("", [CLOUD_A], "JIRA"), isInvalid);
});

test("decode rejects a value that is not base64url JSON", () => {
  assert.throws(
    () => decodeSiteCursor("not-base64-!!!", [CLOUD_A], "JIRA"),
    isInvalid,
  );
});

test("decode rejects JSON that is not an object", () => {
  assert.throws(() => decodeSiteCursor(raw([1]), [CLOUD_A], "JIRA"), isInvalid);
  assert.throws(() => decodeSiteCursor(raw(null), [CLOUD_A], "JIRA"), isInvalid);
});

test("decode rejects a wrong version", () => {
  const encoded = raw({ v: 2, sites: { [CLOUD_A]: null } });
  assert.throws(() => decodeSiteCursor(encoded, [CLOUD_A], "JIRA"), isInvalid);
});

test("decode rejects a site outside the selection", () => {
  const encoded = encodeSiteCursor({ [CLOUD_C]: "token-c" });
  assert.throws(
    () => decodeSiteCursor(encoded, [CLOUD_A, CLOUD_B], "JIRA"),
    isInvalid,
  );
});

test("decode rejects a cursor longer than 4096 characters", () => {
  const encoded = "a".repeat(5000);
  assert.throws(() => decodeSiteCursor(encoded, [CLOUD_A], "JIRA"), isInvalid);
});

test("decode rejects a token that is neither a string nor null", () => {
  const encoded = raw({ v: 1, sites: { [CLOUD_A]: 7 } });
  assert.throws(() => decodeSiteCursor(encoded, [CLOUD_A], "JIRA"), isInvalid);
});

test("decode rejects a `sites` field that is not an object", () => {
  assert.throws(
    () => decodeSiteCursor(raw({ v: 1, sites: [CLOUD_A] }), [CLOUD_A], "JIRA"),
    isInvalid,
  );
  assert.throws(
    () => decodeSiteCursor(raw({ v: 1, sites: "x" }), [CLOUD_A], "JIRA"),
    isInvalid,
  );
});

test("the error code and message carry the product prefix", () => {
  for (const [prefix, product] of [
    ["JIRA", "Jira"],
    ["CONFLUENCE", "Confluence"],
  ] as const) {
    assert.throws(
      () => decodeSiteCursor("not-base64-!!!", [CLOUD_A], prefix),
      (error: unknown) =>
        error instanceof AtlassianApiError &&
        error.statusCode === 400 &&
        error.code === `${prefix}_INVALID_REQUEST` &&
        error.message === `Invalid ${product} cursor`,
    );
  }
});
