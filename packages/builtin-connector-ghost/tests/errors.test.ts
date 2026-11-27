import assert from "node:assert/strict";
import test from "node:test";
import {
  GHOST_ERROR_MESSAGES,
  GhostError,
  isGhostError,
  type GhostErrorCode,
} from "../src/errors";

const TABLE: Record<GhostErrorCode, number> = {
  SITE_URL_INVALID: 400,
  SITE_UNREACHABLE: 502,
  NOT_A_GHOST_SITE: 422,
  BAD_CREDENTIALS: 401,
  BLOCKED_ENDPOINT: 422,
  LINK_INVALID: 502,
  RATE_LIMITED: 429,
  BAD_RESPONSE: 502,
  TOO_LARGE: 422,
  CONFIG_INVALID: 400,
};

test("each code maps to its fixed status and a message", () => {
  for (const [code, status] of Object.entries(TABLE)) {
    const error = new GhostError(code as GhostErrorCode);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(error.name, "GhostError");
    assert.ok(error instanceof Error);
    assert.equal(error.message, GHOST_ERROR_MESSAGES[code as GhostErrorCode]);
    assert.ok(error.message.length > 0);
  }
});

test("the message record has exactly the codes in the table", () => {
  assert.deepEqual(
    Object.keys(GHOST_ERROR_MESSAGES).sort(),
    Object.keys(TABLE).sort(),
  );
});

test("messages are fixed, distinct, and carry no URL, digits or cause", () => {
  const seen = new Set<string>();
  for (const code of Object.keys(TABLE)) {
    const error = new GhostError(code as GhostErrorCode);
    assert.ok(!/http/i.test(error.message), `${code} mentions http`);
    assert.ok(!/\d/.test(error.message), `${code} contains a digit`);
    assert.equal(error.cause, undefined);
    assert.ok(!seen.has(error.message), `${code} repeats a message`);
    seen.add(error.message);
  }
  assert.equal(seen.size, Object.keys(TABLE).length);
});

test("isGhostError narrows only GhostError instances", () => {
  assert.ok(isGhostError(new GhostError("BAD_RESPONSE")));
  assert.ok(!isGhostError(new Error("x")));
  assert.ok(!isGhostError(null));
  assert.ok(!isGhostError({ code: "BAD_RESPONSE", status: 502 }));
});
