import assert from "node:assert/strict";
import { test } from "vitest";
import { serializeAuthLogArgs } from "./auth-log-args";

test("Better Auth error logging retains the cause instead of an empty object", () => {
  const serialized = serializeAuthLogArgs([
    new Error("Mail template cannot resolve public web URL"),
  ]);

  assert.equal(serialized.length, 1);
  assert.deepEqual(
    (serialized[0] as { name: string; message: string }).message,
    "Mail template cannot resolve public web URL",
  );
  assert.deepEqual(
    (serialized[0] as { name: string; message: string }).name,
    "Error",
  );
});
