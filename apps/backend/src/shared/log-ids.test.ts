import assert from "node:assert/strict";
import { test } from "vitest";
import { LOG_ID_LENGTH, shortId } from "./log-ids";

test("shortId keeps only the first eight characters of an identifier", () => {
  const full = "0199cd4f-7b1e-7c3a-9f0e-5d2a1b3c4d5e";
  const short = shortId(full);

  assert.equal(short, "0199cd4f");
  assert.equal(short?.length, LOG_ID_LENGTH);
  assert.notEqual(short, full);
});

test("shortId passes short ids through and maps absent ids to null", () => {
  assert.equal(shortId("abc"), "abc");
  assert.equal(shortId(null), null);
  assert.equal(shortId(undefined), null);
  assert.equal(shortId(""), null);
});
