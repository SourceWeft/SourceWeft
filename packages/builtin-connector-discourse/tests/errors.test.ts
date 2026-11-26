import assert from "node:assert/strict";
import test from "node:test";
import { DiscourseError, type DiscourseErrorCode } from "../src/errors";

const TABLE: Record<DiscourseErrorCode, number> = {
  DISCOURSE_FORUM_URL_INVALID: 400,
  DISCOURSE_FORUM_UNREACHABLE: 502,
  DISCOURSE_NOT_A_DISCOURSE_SITE: 422,
  DISCOURSE_LOGIN_REQUIRED: 422,
  DISCOURSE_BLOCKED_ENDPOINT: 422,
  DISCOURSE_RATE_LIMITED: 429,
  DISCOURSE_BAD_RESPONSE: 502,
  DISCOURSE_TOO_LARGE: 422,
  DISCOURSE_SELECTION_REQUIRED: 422,
  DISCOURSE_CONFIG_INVALID: 400,
};

test("each code maps to its fixed status", () => {
  for (const [code, statusCode] of Object.entries(TABLE)) {
    const error = new DiscourseError(code as DiscourseErrorCode);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.name, "DiscourseError");
    assert.ok(error instanceof Error);
  }
});

test("messages are fixed, distinct, and carry no URL, digits or cause", () => {
  const seen = new Set<string>();
  for (const code of Object.keys(TABLE)) {
    const error = new DiscourseError(code as DiscourseErrorCode);
    assert.ok(error.message.length > 0);
    assert.ok(!/http/i.test(error.message), `${code} mentions http`);
    assert.ok(!/\d/.test(error.message), `${code} contains a digit`);
    assert.equal(error.cause, undefined);
    assert.ok(!seen.has(error.message), `${code} repeats a message`);
    seen.add(error.message);
  }
  assert.equal(seen.size, Object.keys(TABLE).length);
});
