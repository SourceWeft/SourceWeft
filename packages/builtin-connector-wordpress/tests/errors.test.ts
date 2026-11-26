import assert from "node:assert/strict";
import test from "node:test";
import {
  isWordPressError,
  WordPressError,
  WORDPRESS_ERROR_MESSAGES,
  type WordPressErrorCode,
} from "../src/errors";

const TABLE: Record<WordPressErrorCode, number> = {
  SITE_URL_INVALID: 400,
  SITE_UNREACHABLE: 502,
  NOT_A_WORDPRESS_SITE: 422,
  REST_DISABLED: 422,
  LOGIN_REQUIRED: 422,
  BAD_CREDENTIALS: 401,
  INSUFFICIENT_PERMISSION: 422,
  BLOCKED_ENDPOINT: 422,
  LINK_HOST_MISMATCH: 502,
  RATE_LIMITED: 429,
  BAD_RESPONSE: 502,
  TOO_LARGE: 422,
  CONFIG_INVALID: 400,
};

test("each code maps to its fixed status and a message", () => {
  for (const [code, status] of Object.entries(TABLE)) {
    const error = new WordPressError(code as WordPressErrorCode);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(error.name, "WordPressError");
    assert.ok(error instanceof Error);
    assert.equal(
      error.message,
      WORDPRESS_ERROR_MESSAGES[code as WordPressErrorCode],
    );
    assert.ok(error.message.length > 0);
  }
});

test("the message record has exactly the codes in the table", () => {
  assert.deepEqual(
    Object.keys(WORDPRESS_ERROR_MESSAGES).sort(),
    Object.keys(TABLE).sort(),
  );
});

test("messages are fixed, distinct, and carry no URL, digits or cause", () => {
  const seen = new Set<string>();
  for (const code of Object.keys(TABLE)) {
    const error = new WordPressError(code as WordPressErrorCode);
    assert.ok(!/http/i.test(error.message), `${code} mentions http`);
    assert.ok(!/\d/.test(error.message), `${code} contains a digit`);
    assert.equal(error.cause, undefined);
    assert.ok(!seen.has(error.message), `${code} repeats a message`);
    seen.add(error.message);
  }
  assert.equal(seen.size, Object.keys(TABLE).length);
});

test("isWordPressError narrows only WordPressError instances", () => {
  assert.ok(isWordPressError(new WordPressError("BAD_RESPONSE")));
  assert.ok(!isWordPressError(new Error("x")));
  assert.ok(!isWordPressError(null));
  assert.ok(!isWordPressError({ code: "BAD_RESPONSE", status: 502 }));
});
