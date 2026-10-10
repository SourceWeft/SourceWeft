import assert from "node:assert/strict";
import test from "node:test";
import { verifyNiubashArchive } from "./prepare-niubash.mjs";

test("modified or unrelated archives fail the pinned niubash integrity check", () => {
  assert.throws(
    () => verifyNiubashArchive(Buffer.from("untrusted binary")),
    /niubash archive SHA-256 mismatch/,
  );
});
