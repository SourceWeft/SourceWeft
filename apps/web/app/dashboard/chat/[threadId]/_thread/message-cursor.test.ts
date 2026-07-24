import assert from "node:assert/strict";
import { test } from "vitest";
import {
  encodeForwardMessageCursor,
  newestServerCursor,
} from "./message-normalizers";

// Mirror the server's decodeMessagesCursor (service.ts) to prove the client
// encoder produces a cursor the server accepts.
function decodeServerCursor(cursor: string): { createdAt: string; id: string } {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
    createdAt: string;
    id: string;
  };
}

test("encodeForwardMessageCursor round-trips through the server decoder", () => {
  const row = { createdAt: "2026-07-24T10:00:00.000Z", id: "msg-1" };
  assert.deepEqual(decodeServerCursor(encodeForwardMessageCursor(row)), row);
});

test("newestServerCursor picks the max (createdAt,id) tuple, tie-broken by id", () => {
  const items = [
    { createdAt: "2026-07-24T10:00:00.000Z", id: "a" },
    { createdAt: "2026-07-24T10:00:02.000Z", id: "b" },
    { createdAt: "2026-07-24T10:00:02.000Z", id: "c" },
    { createdAt: "2026-07-24T10:00:01.000Z", id: "z" },
  ] as never;

  const cursor = newestServerCursor(items);
  assert.ok(cursor);
  assert.deepEqual(decodeServerCursor(cursor), {
    createdAt: "2026-07-24T10:00:02.000Z",
    id: "c",
  });
});

test("newestServerCursor of an empty page is null", () => {
  assert.equal(newestServerCursor([]), null);
});
