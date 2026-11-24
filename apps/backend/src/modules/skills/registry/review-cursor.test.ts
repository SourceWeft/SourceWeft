import assert from "node:assert/strict";
import { test } from "vitest";
import {
  decodeRegistryReviewCursor,
  encodeRegistryReviewCursor,
} from "./review-cursor";

test("a cursor comes back as the time and id it was made from", () => {
  const cursor = {
    createdAt: new Date("2026-11-15T08:00:00.123Z"),
    id: "ver_1",
  };
  assert.deepEqual(
    decodeRegistryReviewCursor(encodeRegistryReviewCursor(cursor)),
    cursor,
  );
});

test("anything that is not a cursor is refused", () => {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  for (const value of [
    "",
    "not a cursor",
    encode({ createdAt: "2026-11-15T08:00:00.123Z", id: "ver_1" }),
    encode(["not a date", "ver_1"]),
    encode(["2026-11-15T08:00:00.123Z", ""]),
    encode(["2026-11-15T08:00:00.123Z", 7]),
    encode(["2026-11-15T08:00:00.123Z"]),
  ]) {
    assert.equal(decodeRegistryReviewCursor(value), null);
  }
});
