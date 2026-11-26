import assert from "node:assert/strict";
import test from "node:test";
import { ZoteroError, type ZoteroErrorCode } from "../src/errors";

const TABLE: Record<ZoteroErrorCode, number> = {
  ZOTERO_REAUTH_REQUIRED: 422,
  ZOTERO_KEY_INSUFFICIENT_ACCESS: 422,
  ZOTERO_LIBRARY_NOT_FOUND: 404,
  ZOTERO_RATE_LIMITED: 429,
  ZOTERO_UNAVAILABLE: 502,
  ZOTERO_BLOCKED_ENDPOINT: 422,
  ZOTERO_BAD_RESPONSE: 502,
  ZOTERO_TOO_LARGE: 422,
  ZOTERO_CONFIG_INVALID: 400,
};

test("every code carries its pinned status and its own code", () => {
  for (const [code, statusCode] of Object.entries(TABLE)) {
    const error = new ZoteroError(code as ZoteroErrorCode);
    assert.equal(error.statusCode, statusCode, code);
    assert.equal(error.code, code);
    assert.equal(error.name, "ZoteroError");
    assert.ok(error instanceof Error);
  }
});

test("messages are fixed, distinct and leak nothing", () => {
  const seen = new Set<string>();
  for (const code of Object.keys(TABLE)) {
    const error = new ZoteroError(code as ZoteroErrorCode);
    assert.ok(error.message.length > 0);
    assert.doesNotMatch(error.message, /key/i, code);
    assert.doesNotMatch(error.message, /http/i, code);
    assert.doesNotMatch(error.message, /\d+/, code);
    assert.equal(error.cause, undefined);
    seen.add(error.message);
  }
  assert.equal(seen.size, Object.keys(TABLE).length);
});
